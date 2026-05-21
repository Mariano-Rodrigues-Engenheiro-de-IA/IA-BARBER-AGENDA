## Problema

Quando o dono da barbearia adiciona uma etiqueta no contato direto pelo WhatsApp, o lead **não** se move para a etapa correta do funil no CRM do painel.

## Causa raiz

O webhook `whatsapp-webhook` (handler `chats.update` / `chat_labels`, linhas ~1583-1739) lê a configuração de colunas do funil do campo **legado** `tenants.kanban_columns`. Porém o sistema já foi migrado para múltiplos quadros na tabela **`crm_boards`** (cada board tem seu próprio `columns: jsonb`).

Verificação no banco confirma o problema. Quase todos os tenants ativos têm `tenants.kanban_columns = []` mas possuem boards configurados em `crm_boards`. Exemplos:

- BAREBARIA DO REGIS → 0 colunas legadas, 1 board novo
- BARBEARIA MARQUEZ Asa Sul → 0 colunas legadas, 0 boards (sem CRM)
- BENDITA BARBER → 0 colunas legadas, 1 board

Consequência no código:
```
const kanbanCols = syncTenant.kanban_columns; // = []
const configuredLabelIds = [];               // vazio
for (labelId of waLabels) {
  if (!configuredLabelIds.includes(labelId)) continue; // ← TUDO ignorado
}
```
→ Nenhum label do WhatsApp é reconhecido → funil nunca muda → log `[LabelSync] No changes`.

A IA funciona porque ela usa `move-crm-lead` que escreve direto no `crm_leads` (não depende dessa config para classificar).

## Correção

Em `supabase/functions/whatsapp-webhook/index.ts`, no handler de `chats.update`:

1. **Trocar a fonte da config de colunas:** ler de `crm_boards` (todos os boards do tenant), unir todas as `columns`, em vez de `tenants.kanban_columns`.
2. **Manter fallback** para `tenants.kanban_columns` caso o tenant ainda use o modelo legado (alguns têm valor).
3. **Capturar `board_id`** ao identificar o funil: ao classificar `labelId` como funnel, lembrar de qual board ele veio para que, ao **inserir** novo lead, `board_id` seja preenchido (hoje cai como `null` e leads ficam fora dos boards no painel cliente).
4. **Mesmo ajuste no bloco de IA OFF / flags** (linhas ~802-870 e ~1145-1195) que também lê `kanban_columns` — fazer leitura unificada uma única vez no início do request, reutilizar.
5. **Logs**: adicionar log explícito quando um `labelId` vem do WhatsApp mas não está em nenhuma coluna configurada, para facilitar diagnóstico futuro.

## Detalhes técnicos

Helper a ser adicionado no topo do handler:

```ts
async function loadTenantKanbanColumns(supabase, tenantId, legacyCols) {
  const { data: boards } = await supabase
    .from("crm_boards")
    .select("id, columns")
    .eq("tenant_id", tenantId);
  const fromBoards = (boards ?? []).flatMap(b =>
    (Array.isArray(b.columns) ? b.columns : []).map(c => ({ ...c, board_id: b.id }))
  );
  if (fromBoards.length) return fromBoards;
  // fallback legacy
  return (Array.isArray(legacyCols) ? legacyCols : []).map(c => ({ ...c, board_id: null }));
}
```

E no insert de novo lead (linha ~1712):
```ts
const funnelCol = newFunnelLabel ? kanbanCols.find(c => String(c.label_id) === newFunnelLabel) : null;
await supabase.from("crm_leads").insert({
  ...,
  board_id: funnelCol?.board_id ?? null,
});
```

## Validação

1. Aplicar uma etiqueta de funil direto no WhatsApp para um contato de teste no tenant **BAREBARIA DO REGIS**.
2. Conferir nos logs do `whatsapp-webhook`:
   - `[LabelSync] Parsed label IDs from WhatsApp: [...]` deve conter o ID.
   - Linha nova de log `[LabelSync] configuredLabelIds: [...]` deve mostrar o ID configurado.
   - Resultado deve ser `label_synced` com `funnelChanged: true`.
3. Conferir no painel cliente → CRM → o lead aparece na coluna correta sem refresh manual (após poll/refetch).
4. Aplicar uma etiqueta de **flag** (ex: IA OFF) e confirmar que entra em `flag_labels`, não em `label_id`.

## Escopo fora desta correção

- Não mexer na lógica de envio de mensagens nem na deduplicação da IA.
- Não alterar `move-crm-lead` (sentido painel → WhatsApp já funciona).
- Não migrar dados em `tenants.kanban_columns` (fica como fallback).