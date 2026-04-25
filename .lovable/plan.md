## Diagnóstico

Confirmei no banco que o lead `556183012868` está com `flag_labels: {15}` (etiqueta IA OFF) salva, mesmo o owner tendo removido a etiqueta no WhatsApp:

```
phone_number | label_id |   label_name    | flag_labels |          updated_at
556183012868 |    15    | Escalado Humano |    {15}     | 2026-04-25 01:53:24
```

Esse é o estado "stale" que está bloqueando a IA.

### Causa raiz

A correção anterior só sincroniza em **uma direção** — quando a etiqueta IA OFF é **adicionada** no WhatsApp, o sistema copia para o DB. Mas quando o owner **remove** a etiqueta no WhatsApp, **nada apaga ela do DB**, porque:

1. UAZAPI desta conta **não emite** o evento `chats.update` (já confirmado nos logs anteriores).
2. A primeira checagem de IA OFF (linhas 195–254 do `whatsapp-webhook/index.ts`) usa OR entre DB e WhatsApp: se o DB tem a flag, bloqueia, sem nem olhar se o WhatsApp ainda tem.

Resultado: cliente sem etiqueta no WhatsApp + IA muda + dono perdido.

---

## Correção

Reescrever o bloco "IA OFF CHECK" tornando o **WhatsApp a fonte da verdade** (`payload.chat.wa_label`), com sincronização **bidirecional** a cada mensagem:

| Estado WhatsApp | Estado DB | Ação |
|---|---|---|
| Tem IA OFF | Não tem | Adiciona no DB → bloqueia IA |
| Tem IA OFF | Tem | Bloqueia IA |
| **Não tem IA OFF** | **Tem (stale)** | **Remove do DB → libera IA** ← novo |
| Não tem IA OFF | Não tem | Libera IA |

Como bônus, fazer reconciliação completa de TODAS as flag labels configuradas (não só IA OFF). Se o owner adicionar/remover qualquer etiqueta tipo flag no WhatsApp, o DB reflete na próxima mensagem do cliente — sem depender de evento `chats.update`.

### Detalhes técnicos

**Arquivo:** `supabase/functions/whatsapp-webhook/index.ts` (linhas 195–254, único bloco)

**Lógica nova:**
1. Ler `flag_labels` do DB e `payload.chat.wa_label` do payload em paralelo.
2. Calcular `dbHasIaOff` e `waHasIaOff`.
3. Se `waHasIaOff && !dbHasIaOff` → INSERT/UPDATE adicionando flag no DB.
4. Se `!waHasIaOff && dbHasIaOff` → UPDATE removendo flag stale do DB e liberar IA.
5. Reconciliação geral: comparar conjunto de flags do WhatsApp com o do DB; se diferente, sobrescrever o DB com o do WhatsApp (apenas labels configuradas como `type: "flag"` no kanban).
6. Decisão final usa `waHasIaOff` (verdade do WhatsApp), não o DB.

**Sem mudanças em:**
- Schema do banco
- Outras edge functions
- Lógica de fluxo de funil (label_id principal continua sendo gerenciada pelo handler `LabelSync` separado)
- Frontend

**Limpeza imediata pós-deploy:** Remover manualmente a flag stale `{15}` do lead `556183012868` para destravar o cliente atual (o WhatsApp não tem a etiqueta, então isso só repara o estado já corrompido).