## Diagnóstico (o que já funciona vs o que está quebrado)

Investiguei o código (`supabase/functions/whatsapp-webhook/index.ts`) e os logs reais do edge function. Resultado:

### ✅ Já funciona corretamente
1. **Ferramenta `escalar_humano` aplica a etiqueta IA OFF** — Os logs mostram com sucesso:
   - `[EscalateHuman] Label ADD attempt: POST /chat/labels {"number":"556183012868","add_labelid":"15"}`
   - `[EscalateHuman] Label result status: 200 body: {"response":"Label added to chat"}`
   - `[EscalateHuman] Label 15 ensured present (changed)`
   - E logo na mensagem seguinte: `IA OFF flag detected for 556183012868 ... skipping AI`
   
   Para o tenant BARBEARIA CHAMPION o `label_id: "15"` está corretamente configurado na ferramenta, e a coluna `IA OFF` no kanban também é `label_id: 15` tipo `flag`. Então quando a IA escala, a etiqueta é colocada e a IA para. **Conferi no banco e nos logs — está funcionando hoje.**

2. **Quando o cliente envia mensagem com a label IA OFF já aplicada** — o webhook lê `chat.wa_label` do payload, detecta o flag, sincroniza no DB e bloqueia a IA (logs confirmam).

### ❌ Bugs reais encontrados

**BUG 1 — IA OFF aplicada DURANTE o debounce de 10s não é respeitada**

Fluxo atual:
```
cliente manda msg → check IA OFF (flag ainda não aplicada) → espera 10s (debounce)
   ↓ (durante esses 10s, owner aplica etiqueta IA OFF no WhatsApp)
   → após 10s, processa msg e responde NORMALMENTE (não revalida o flag)
```

A checagem de IA OFF acontece UMA VEZ no início (linha 195–254) antes do `await sleep(DEBOUNCE_MS)` (linha 453). Não é refeita depois. Se o owner reage rápido aplicando a etiqueta no WhatsApp, a IA ignora.

**BUG 2 — UAZAPI não envia evento `chats.update` neste workspace**

O handler `LabelSync` (linhas 696+) escuta `chats.update | chats.upsert | chat.update | chat_labels`. Mas analisando 100% dos logs recentes do webhook, **o único `EventType` recebido é `messages`**. O UAZAPI desta conta nunca dispara eventos de mudança de etiqueta isolados. Resultado: se o owner aplica a etiqueta IA OFF no WhatsApp e o cliente não envia mensagem nova, a IA continua "ativa" — só vai pausar na próxima mensagem do cliente. Isso pode dar a sensação de "não funciona", embora tecnicamente funcione na próxima mensagem.

**BUG 3 — IA diz "mandei o link" sem colar o link no texto**

Para `provider = "none"`, o sistema só considera "link enviado" se `tenant.booking_link` aparecer literalmente em `aiResponseText` (linha 576). Não há ferramenta — o prompt manda colar a URL no texto. O prompt já proíbe explicitamente dizer "mandei o link" sem o link estar escrito (linha 3796 e 3811), mas não há nenhum **enforcement no código**. Se o modelo alucinar e mandar "te enviei o link 👇" sem a URL, a mensagem vai pro cliente assim mesmo.

---

## Correções propostas

### Fix 1 — Revalidar IA OFF após o debounce (BUG 1)
Em `whatsapp-webhook/index.ts`, logo depois do `await new Promise(r => setTimeout(r, DEBOUNCE_MS))` (linha 453) e antes de processar as mensagens combinadas, refazer a checagem de IA OFF:
- Reconsultar `crm_leads.flag_labels` no DB
- Buscar o estado atual das labels do chat na UAZAPI via `GET /chat/details` (ou endpoint equivalente já usado em `chatHasLabel`/`chatDetailsPayload`) para pegar `wa_label` em tempo real
- Se IA OFF estiver presente: marcar mensagens como `processed: true` (para não reprocessar), retornar `status: ia_off_after_debounce` sem chamar a IA

Isso garante que se o owner aplicar a etiqueta nos 10s do debounce, a IA respeita imediatamente.

### Fix 2 — Polling leve para detectar IA OFF aplicada manualmente (BUG 2)
Como o UAZAPI deste workspace não emite eventos `chats.update`, criar um mecanismo alternativo simples:
- **Opção A (recomendada, sem cron novo)**: Reaproveitar o Fix 1 — buscar o estado atualizado das labels via UAZAPI sempre que uma mensagem é processada. Já resolve a maioria dos casos práticos (o owner aplica IA OFF justamente porque há conversa ativa).
- **Opção B (extra)**: Adicionar um cron `pg_cron` a cada 1 min que chama um novo edge function (`sync-ia-off-labels`) para buscar `/chat/details` de chats com mensagens recentes (últimos 30 min) e atualizar `crm_leads.flag_labels`. Mais robusto mas adiciona complexidade.

Sugiro começar pela **Opção A**, que sozinha resolve o cenário real reclamado.

### Fix 3 — Bloquear resposta que afirma "mandei o link" sem o link (BUG 3)
Adicionar um validador pós-resposta no `callAIAgent` (no caminho do provider `none`):
1. Detectar frases típicas: regex como `/(mandei|enviei|te\s+enviei|segue|aqui\s+está|aí\s+está|tá\s+aí)\s+(o\s+)?link/i`, `/link\s+(de\s+agendamento|pra\s+agendar|para\s+agendar)/i`, `/clica?\s+no\s+link/i`, etc.
2. Se a resposta contém uma dessas frases E `tenant.booking_link` NÃO aparece literalmente no texto → considerar resposta inválida.
3. Ação: regenerar UMA vez com mensagem de sistema reforçando "Cole literalmente esta URL: `<booking_link>`". Se ainda assim não vier, **injetar a URL automaticamente** ao final do texto (fallback seguro: cliente sempre recebe o link quando a IA disse que mandou).

Aplicar apenas para `provider === "none"` e quando `tenant.booking_link` existir.

---

## Detalhes técnicos

**Arquivos afetados:**
- `supabase/functions/whatsapp-webhook/index.ts` (único arquivo)

**Trechos a editar:**
- Linha ~453 (após `setTimeout(DEBOUNCE_MS)`): inserir bloco de revalidação IA OFF (DB + chamada UAZAPI `/chat/details`)
- Linha ~575 (após `aiResponseText` para provider `none`): inserir validador de "link claim" + lógica de fallback antes do envio
- Reutilizar funções já existentes: `ensureChatLabelState`, `chatHasLabel`/`chatDetailsPayload` (linha ~2509), padrão de fetch UAZAPI já estabelecido

**Sem mudanças em:**
- Schema do banco
- Configuração de tenants
- Outras edge functions
- Frontend

**Testes manuais sugeridos após deploy:**
1. Cliente manda msg → owner aplica IA OFF nos 5s seguintes → IA não responde ✅
2. Cliente manda msg sem nada → IA responde normal ✅
3. Cliente pede pra agendar → resposta contém o booking_link literalmente ✅
4. Forçar caso onde IA diga "te mandei o link" sem colar → sistema injeta o link no fim ✅