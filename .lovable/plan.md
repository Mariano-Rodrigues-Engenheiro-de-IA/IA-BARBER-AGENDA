## Diagnóstico

Olhando os logs reais da conversa de teste (BARBEARIA MARQUEZ Ceilândia):

```
Tool result (buscar_servicos): [{"gservsID":565,"descricao":"Barbearia Asa Sul",...]
Tracked OneBeleza service IDs: [2469, 2468, 2461, 2473, ...]  ← 48 IDs (todos os grupos)
```

A IA recebeu **48 serviços de TODAS as unidades** (Barbearia Asa Sul, Estúdio Asa Sul, Barbearia Ceilândia, Estúdio Ceilândia). Por isso pegou `servicosId 2467` que é da Asa Sul, e o `buscar_barbeiros` voltou `[]` (Nicolas não atende esse serviço da Asa Sul).

**Causa raiz**: o filtro `onebeleza_unit_filter: ["Ceilandia"]` está corretamente salvo no banco, mas no log NÃO aparece a linha `[OneBeleza] buscar_servicos unit filter: X → Y groups`. Isso indica que o filtro existente é silencioso quando falha, e provavelmente o `parsed` não passou no `Array.isArray()` (a API às vezes embrulha em `{data: [...]}`) OU o tenant em cache não trouxe `agent_settings`. De qualquer forma, **ter um único filtro silencioso é frágil** — qualquer falha nele expõe a IA a 48 serviços confusos.

## Solução: três camadas de defesa

### Camada 1 — Filtro robusto em `buscar_servicos` (corrigir o atual)

Em `supabase/functions/whatsapp-webhook/index.ts` (~linha 4828), reescrever o case `buscar_servicos`:

- Logar SEMPRE: `[OneBeleza] filter check: rawFilter=..., parsedType=..., parsedLen=...` antes de decidir filtrar — assim conseguimos diagnosticar imediatamente quando falhar.
- Aceitar tanto `parsed` array direto quanto `{data: [...]}` ou `{grupos: [...]}` (defensivo).
- Se `filterList` está configurado mas resultado filtrado é `[]`, retornar erro explícito `{ error: "Nenhum grupo de serviço da unidade configurada foi encontrado. Verifique onebeleza_unit_filter." }` em vez de array vazio (evita IA inventar).

### Camada 2 — Pré-filtro no nível de servicosId permitido (NOVO)

Após filtrar grupos, computar o **set de servicosId permitidos** (todos os IDs dentro dos grupos que sobreviveram ao filtro) e armazenar em `sessionState.allowedServiceIds`.

Em `resolveOneBelezaToolArgs` (camada de validação que já existe), adicionar regra:

- Se `tool ∈ {buscar_barbeiros_por_servico, buscar_datas_disponiveis, buscar_horarios, agendar}` e o `servicosId` enviado pela IA **não está em `allowedServiceIds`**, **bloquear a chamada** retornando:

```json
{
  "error": "servicosId X não pertence à unidade desta barbearia. Use APENAS um dos seguintes IDs: [lista]",
  "blocked": true
}
```

Isso garante que mesmo se a IA tentar (ou alucinar) um ID da Asa Sul, o servidor recusa antes de chamar a API One Beleza.

### Camada 3 — Reforço no prompt do sistema

Adicionar no `agent_system_prompt` da Marquez Ceilândia (e da Asa Sul) uma seção curta e enfática logo no início:

```
🔒 REGRA INVIOLÁVEL DE UNIDADE
Você atende EXCLUSIVAMENTE na unidade [Ceilândia/Asa Sul].
O sistema retorna serviços de várias unidades — você DEVE usar APENAS
serviços que vieram do grupo cuja descrição contém "[Ceilândia/Asa Sul]".
NUNCA use IDs de outras unidades. Se o cliente pedir outra unidade,
escalar humano.
```

E no `buildOneBelezaPromptSection` (~linha 3845), injetar dinamicamente a lista de `allowedServiceIds` a cada resposta, tipo:

```
SERVIÇOS PERMITIDOS NESTA UNIDADE (servicosId): 2475, 2476, 2477, 2467, ...
NÃO use nenhum servicosId fora dessa lista.
```

## Arquivos afetados

- `supabase/functions/whatsapp-webhook/index.ts`
  - case `buscar_servicos` (~L4828): logging defensivo + tratamento de `[]` filtrado.
  - bloco "Tracked OneBeleza service IDs" (~L2390): popular `sessionState.allowedServiceIds`.
  - `resolveOneBelezaToolArgs` (função existente): adicionar guard de `allowedServiceIds`.
  - `buildOneBelezaPromptSection` (~L3845): injetar lista permitida no prompt.
- 1 migration SQL pra atualizar `agent_system_prompt` dos dois tenants Marquez com a regra inviolável no topo.

## Sem mudanças

- Schema do banco.
- RLS, novas tabelas, tokens.
- Frontend.

## Validação

Depois do deploy:
1. Rodar `❌` no WhatsApp pra resetar `conversation_state`.
2. Pedir um corte com visagismo.
3. Conferir nos logs:
   - `[OneBeleza] filter check: ...` (camada 1 ativa)
   - `Tracked OneBeleza service IDs: [...]` deve ter ~12 IDs (só Ceilândia), não 48.
   - Se a IA tentar um ID errado: `[Resolver] Blocked: servicosId X not in allowed set`
4. Confirmar que `buscar_barbeiros` retorna lista NÃO-vazia.

## Risco

Baixo. As 3 camadas são aditivas e independentes — se uma falhar, as outras ainda protegem. Outros tenants One Beleza sem `onebeleza_unit_filter` continuam funcionando normalmente (filtro inativo por padrão).
