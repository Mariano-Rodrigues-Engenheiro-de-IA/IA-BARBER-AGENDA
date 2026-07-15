# Plano de Contingência — Migração UAZAPI → WhatsApp Cloud API (Meta)

Documento de referência. **Nada implementado.** Objetivo: ter o caminho mapeado pra ativar rápido se a UAZAPI (não oficial) parar de funcionar.

Data do levantamento: 2026-07-15
Stack atual afetada: `supabase/functions/whatsapp-webhook`, `supabase/functions/whatsapp-instance`, `process-followups`, campos `tenants.uazapi_url` / `tenants.uazapi_token` / `tenants.whatsapp_number`.

---

## 1. O que muda tecnicamente no sistema

### 1.1 Webhook de recebimento (entrada)

**Hoje (UAZAPI):** payload plano, geralmente `{ event, instance, message: { sender, text, type, mediaUrl, ... } }`. O `whatsapp-webhook/index.ts` faz *tenant lookup* por `uazapi_token`/`instance` e por `whatsapp_number`. Autenticação por `WHATSAPP_WEBHOOK_SECRET` (query/header).

**Cloud API (Meta):** payload aninhado padrão Graph API:
```
{ object: "whatsapp_business_account",
  entry: [{ id: <WABA_ID>, changes: [{ field: "messages",
    value: { messaging_product: "whatsapp",
             metadata: { display_phone_number, phone_number_id },
             contacts: [{ wa_id, profile: { name } }],
             messages: [{ from, id, timestamp, type, text: { body }, image: {...}, audio: {...}, interactive: {...} }] } }] }] }
```
Cada evento pode trazer **N mensagens** e também **statuses** (sent/delivered/read/failed) no mesmo envelope. Autenticação: `X-Hub-Signature-256` (HMAC SHA-256 com App Secret) + verificação inicial GET com `hub.verify_token`.

**Impacto no código:**
- **Camada de parsing isolada** (~150-250 linhas novas): normalizar o payload Meta pro formato interno que o `whatsapp-webhook` já consome (`{ tenantId, phoneNumber, text, mediaType, mediaId, messageId, timestamp }`). Se essa camada for bem feita, **o resto do pipeline (guards, IA, providers, dedupe, ledger, follow-ups, CRM) não precisa mudar**.
- **Tenant lookup muda de chave:** hoje é por `whatsapp_number` string simples; passa a ser por `metadata.phone_number_id` (ID numérico único que a Meta emite por número). Precisa adicionar coluna `tenants.meta_phone_number_id` e `tenants.meta_waba_id`.
- **Verificação de assinatura:** trocar `WHATSAPP_WEBHOOK_SECRET` (query) por HMAC do App Secret. **Manter a regra "nunca fail-open"** já estabelecida.
- **Endpoint GET de verificação inicial** (obrigatório pra Meta ativar o webhook): retornar `hub.challenge` se `hub.verify_token` bater. ~10 linhas.
- **Loop de múltiplas mensagens por envelope:** hoje o webhook trata 1 mensagem por request. Precisa iterar `entry[].changes[].value.messages[]` e enfileirar cada uma pro pipeline (o debounce de 10s atual continua valendo por telefone).
- **Statuses (sent/delivered/read/failed)** viram um caminho separado — hoje não temos isso. Pode ser ignorado no MVP da migração; útil no futuro pra métricas de entrega.

### 1.2 Envio de mensagem (saída)

**Hoje:** `POST {uazapi_url}/send/text` com header `token`, payload `{ number, text }`. Sem rate limit formal.

**Cloud API:**
- Endpoint fixo: `POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages`
- Auth: `Authorization: Bearer {SYSTEM_USER_ACCESS_TOKEN}` (token permanente por WABA/system user)
- Payload: `{ messaging_product: "whatsapp", to: "<E.164 sem +>", type: "text", text: { body: "..." } }`
- **Rate limits reais:**
  - Nível inicial: 250 conversas iniciadas/24h por número (sobe automaticamente com qualidade: 1k → 10k → 100k → ilimitado).
  - Throughput de mensagens: 80 msg/s por número no tier padrão, sobe até 1000 msg/s.
  - Não é problema pro caso de uso (barbearia), mas **precisa respeitar backoff em 429/`#131056`** — a lógica de retry que já existe pros providers serve de modelo.

**Impacto no código:**
- Trocar chamada UAZAPI em `whatsapp-webhook` e no `process-followups` por um `sendViaMeta()`. Substituição pontual, ~1 função.
- **Restrição crítica: janela de 24h.** Só pode enviar mensagem "livre" (`text`) se o cliente enviou algo nas últimas 24h. Fora dessa janela **precisa ser template aprovado** (ver §2.4). O sistema hoje envia texto livre sempre — segue funcionando **dentro** da janela porque o cliente sempre inicia. Onde quebra: follow-ups e lembretes automáticos que caem fora de 24h.

### 1.3 Mídia (imagem, áudio, localização, documento)

**Hoje (UAZAPI):** manda URL pública direto (`file: "https://..."`), UAZAPI baixa e reencaminha. Recebimento: URL de mídia pronta no payload.

**Cloud API:** fluxo em 2 passos, mais chato:

**Envio:**
1. Upload prévio: `POST /{PHONE_NUMBER_ID}/media` com `multipart/form-data` → retorna `media_id`.
2. `POST /{PHONE_NUMBER_ID}/messages` com `type: "image" | "audio" | "document" | "video"` e `image: { id: "<media_id>", caption: "..." }`.
- Alternativa: passar `link` público direto no lugar de `id` (evita upload, mas Meta valida o link).

**Recebimento:** o payload traz só `media.id`. Pra baixar: `GET /{media_id}` → devolve URL temporária → `GET <URL>` com Bearer token. URL expira em 5 min.

**Formatos aceitos:**
- Áudio: `audio/aac`, `audio/mp4`, `audio/mpeg`, `audio/amr`, `audio/ogg` (codec opus, mono). Nosso fluxo de STT precisa validar.
- PTT (voice note): `type: "audio"` com `voice: true`.

**Localização:** `type: "location"` com `latitude`, `longitude`, `name`, `address` — igual conceito, payload diferente. Trivial.

**Custom tools** (`send_combo`, `send_image`, `send_audio` etc. em `CustomToolsTab.tsx`): cada uma precisa de branch `if (provider === "meta") { ... }` no envio. ~1 dia de trabalho pra portar todas.

### 1.4 Multi-tenant / múltiplos números

**Hoje (UAZAPI):** cada tenant tem sua própria instância (URL + token). Isolamento total.

**Cloud API:**
- Uma **WABA** (WhatsApp Business Account) pode ter **até 25 números**. Uma conta Meta Business pode ter várias WABAs.
- Um único **System User Access Token** consegue operar todos os números de todas as WABAs sob a mesma Business Manager.
- Estrutura recomendada: **1 Meta Business Manager (nossa) → N WABAs (uma por barbearia OU compartilhadas se elas topam) → 1 número por WABA por padrão**.
- **Cada barbearia continua com seu número próprio.** O que muda é onde esse número está registrado (Meta em vez de UAZAPI).

**Modelo BSP vs Direto:**
- **Direto (self-serve):** cada barbearia faz Embedded Signup, aprova acesso pra nossa Business, número fica na WABA dela. Sem custo por conversa além do que a Meta cobra. Recomendado.
- **BSP (via 360dialog, Gupshup, Twilio, MessageBird):** simplifica onboarding mas cobra markup por conversa. Útil se quiser abstrair a Meta.

---

## 2. O que o Mariano precisa providenciar (por tenant)

### 2.1 Conta comercial verificada (WABA)

- Cada barbearia precisa de uma **Meta Business Manager verificada** (a dela ou a nossa com ela como cliente).
- **Business Verification** exige: CNPJ ativo, documento de constituição (contrato social ou equivalente), comprovante de endereço da empresa, site oficial OU perfil comercial ativo. Comprovação de vínculo entre pessoa que abre e a empresa.
- Alternativa: usar **Embedded Signup** — a barbearia loga com Facebook, cria/vincula a WABA dela e concede permissão pra nossa Business Manager gerenciar. Isso reduz fricção mas ainda precisa da verificação.
- **Centralização parcial possível:** podemos ser Solution Partner / Tech Provider gerenciando as WABAs delas. Não elimina a verificação delas, mas centraliza gestão técnica (tokens, webhooks, deploy).

### 2.2 Portabilidade de número

**Sim, dá pra portar.** Fluxo oficial "Migrate a Phone Number":
1. Número precisa estar **saudável** (sem bloqueio, sem spam flags).
2. Se o número está em WhatsApp Business App (app do celular): fazer backup, desinstalar, iniciar registro na Cloud API → recebe SMS/voz de verificação.
3. Se o número está em outra BSP/UAZAPI: precisa **desregistrar do UAZAPI primeiro** (fazer logout na instância). Janela de indisponibilidade: **minutos a algumas horas** enquanto a Meta reprovisiona.
4. Após verificação, o número aparece na WABA e recebe um `phone_number_id`.

**Riscos reais:**
- Se o número está associado a um WhatsApp pessoal do dono, precisa migrar pro Business primeiro (perde histórico de conversa, contatos ficam).
- **Número não pode ter sido registrado no WhatsApp Business (não Cloud) recentemente** sem passar pelo processo correto.
- Ideal: agendar janela de baixa demanda (madrugada de terça, por exemplo) e portar 1 número por vez.

### 2.3 Documentação exigida pela Meta

Por Business Manager (uma vez):
- CNPJ.
- Contrato social / documento de constituição.
- Comprovante de endereço (conta de luz, contrato de aluguel).
- Website oficial da empresa (mesmo domínio do e-mail comercial ajuda).
- Se o site não existir: perfil comercial ativo no Facebook/Instagram vinculado.

Por número (Display Name approval):
- Nome comercial que aparecerá pro cliente. Precisa bater com nome fantasia / marca. **Aprovação leva 1-3 dias**, pode ser rejeitada se o nome for muito genérico.

### 2.4 Templates de mensagem (Message Templates)

**Onde a IA precisa hoje de template aprovado:**

| Fluxo atual | Precisa template? | Motivo |
|---|---|---|
| Resposta à mensagem do cliente | **Não** | Dentro da janela de 24h |
| `enviar_link_agendamento` como resposta | **Não** | Dentro da janela |
| Follow-up "after_no_reply" (janela ≤ 24h) | **Não** | Ainda dentro da janela |
| Follow-up "after_link_sent" (se passar 24h) | **Sim** | Fora da janela |
| Lembrete de agendamento no dia (D-1, D-0) | **Sim** | Sempre iniciado pela empresa |
| Reengajamento pós-serviço | **Sim** | Iniciado pela empresa |
| Cobrança/mensalidade | **Sim** | Iniciado pela empresa |

**Templates que já dá pra desenhar e submeter agora (economiza tempo depois):**
1. `lembrete_agendamento_dia_seguinte` — utility, categoria "Utility". Variáveis: `{{1}} nome_cliente, {{2}} servico, {{3}} data_hora, {{4}} profissional`.
2. `lembrete_agendamento_hoje` — utility. Mesmas variáveis.
3. `retomada_conversa_apos_24h` — marketing ou utility (depende do conteúdo). Variáveis: `{{1}} nome_cliente, {{2}} link_agendamento`.
4. `confirmacao_pos_atendimento` — utility. `{{1}} nome_cliente, {{2}} nome_barbearia`.

**Aprovação de template:** normalmente 1-24h. Categoria "Marketing" tem mais rejeição; "Utility" e "Authentication" passam mais fácil. Rejeição típica: linguagem promocional em template utility, emoji excessivo, CTA sem contexto.

---

## 3. Passo a passo de migração (ordem certa)

### Fase 0 — Preparação (dá pra fazer agora, sem urgência)
1. Criar Meta Business Manager da Zaylo e passar por Business Verification. **Fazer isso hoje, guardado no bolso** — não custa nada e a verificação leva 1-5 dias úteis.
2. Rascunhar os 4 templates listados em §2.4 e submeter à aprovação. Templates aprovados ficam disponíveis quando precisar.
3. Adicionar colunas ao schema (migration pronta pra rodar quando precisar): `tenants.meta_phone_number_id`, `tenants.meta_waba_id`, `tenants.transport` (`enum: 'uazapi' | 'meta'`, default `uazapi`).

### Fase 1 — Infra técnica (só quando decidir migrar)
1. Criar edge function `whatsapp-webhook-meta` que faz o parsing do payload Meta e chama o mesmo pipeline interno do webhook atual.
2. Implementar `sendViaMeta()` no `whatsapp-webhook` e no `process-followups`, com switch por `tenants.transport`.
3. Portar as custom tools de envio (imagem, áudio, localização, combo) pra rota Meta.
4. Testar com **1 número interno** (nosso, não de cliente) durante 3-5 dias em paralelo à UAZAPI.

### Fase 2 — Migração dos tenants (tenant por tenant, **não tudo de uma vez**)
1. Escolher tenant piloto — idealmente o de menor volume ou o mais tolerante a falhas.
2. Agendar janela de manutenção com o dono (madrugada).
3. Desregistrar número do UAZAPI → registrar na WABA → verificar SMS → aprovar Display Name → atualizar `tenants.transport = 'meta'` + `meta_phone_number_id`.
4. **Janela de indisponibilidade real por tenant: 30 min a 2h** (SMS + config).
5. Monitorar 48h antes de mover o próximo.

### Fase 3 — Deprecação UAZAPI
Depois que todos migraram: remover código legacy de UAZAPI, dropar colunas `uazapi_url`/`uazapi_token`. Não urgente.

### Tempo total realista
- **Fase 0**: 1 semana (esperando Meta verificar).
- **Fase 1**: 3-5 dias de dev + testes.
- **Fase 2**: 30 min a 2h por tenant, sequencial. Com 50 tenants: 2-3 semanas em ritmo confortável.
- **Templates**: 1-3 dias de aprovação cada, submeter em lote.

### O gargalo histórico é SEMPRE a Meta, não o código
Business Verification: 1-5 dias. Display Name: 1-3 dias por número. Template: 1-24h por template. **Se começar Fase 0 hoje, quando precisar migrar de emergência, já tem tudo aprovado e a migração vira só operacional.**

---

## 4. Riscos e pontos de atenção

### 4.1 Comportamento do sistema

- **Guards e ledger:** continuam valendo — são lógica interna, não dependem do transporte. ✅
- **Prompts:** nenhuma mudança necessária. ✅
- **Debounce de 10s:** continua funcionando por telefone. ✅
- **PhantomConfirmationGuard, MultiBookingGuard, retries de provider:** intactos. ✅
- **Follow-ups fora de 24h:** **quebram sem template.** Se migrar sem ter template aprovado, o follow-up `after_link_sent` que dispara horas depois vai falhar silenciosamente. **Bloqueador real.**
- **Áudio recebido:** precisa adaptar o download de mídia (fluxo 2 passos com token) antes do STT. Se não adaptar, IA para de entender áudio.
- **Latência de resposta:** Meta é levemente mais lenta que UAZAPI (~200-500ms extra por envio). Não afeta UX perceptível.
- **`isLeakedReasoningResponse` e demais guards de conteúdo:** intactos.

### 4.2 Janela de indisponibilidade

- **Por tenant, durante a migração:** 30 min a 2h enquanto o número passa de UAZAPI → Meta. Cliente que mandar mensagem nesse intervalo **não recebe resposta e a mensagem se perde** (não fica em fila). Mitigação: avisar o dono da barbearia pra postar status "sistema em manutenção até HH:MM".
- **Se UAZAPI cair de vez sem aviso:** sem Fase 0 pronta, você tem **1 semana no mínimo** de downtime total (verificação Meta + display name + templates). Com Fase 0 pronta: **1-3 dias** por tenant.

### 4.3 Pontos que a IA/prompts vão precisar aprender

- Diferenciar quando pode responder livre vs quando precisa disparar template (dentro/fora de 24h). Isso pode virar um helper `canSendFreeText(phoneNumber, tenantId)` que checa timestamp da última mensagem do cliente.
- Interactive messages (botões, listas) da Cloud API abrem UX melhor — não precisa migrar tudo de imediato, mas depois vale explorar (ex: botões "Confirmar / Reagendar / Cancelar" em vez de texto livre).

### 4.4 Custo

- **Mensagens de serviço (resposta dentro de 24h) deixam de ser grátis a partir de 01/10/2026.** Antes desse date, o modelo era cobrança por conversa iniciada e Service tinha free tier de 1000/mês por número. A partir de outubro, a Meta cobra **por mensagem enviada** — incluindo exatamente as respostas de IA/chatbot dentro da janela de 24h.
- Valor de referência no Brasil: ~**R$ 0,035 por mensagem** (~US$ 0,0068), com desconto por volume alto. Cada mensagem da IA (texto, confirmação, recondução, follow-up dentro de 24h) conta.
- **Utility** (lembretes de agendamento, fora da janela de 24h) e **Marketing** mantêm a lógica de categoria por conversa iniciada (~R$ 0,04-0,08 para Utility e ~R$ 0,20-0,35 para Marketing, valores orientativos).
- **Fluxo atual (cliente sempre inicia, IA responde dentro de 24h) não é mais "quase gratuito"** — é o cenário que mais será impactado pelo novo preço por mensagem. A estimativa de custo real esperada só será possível quando o levantamento de volume real dos últimos 15 dias (contagem de mensagens de IA enviadas) retornar.

---

## 5. Checklist "pronto pra ativar em emergência"

Se fizer só isso agora, o dia da emergência vira operacional em vez de projeto:

- [ ] Meta Business Manager criada e verificada
- [ ] 4 templates rascunhados e aprovados
- [ ] Migration adicionando `meta_phone_number_id`, `meta_waba_id`, `transport` pronta (não aplicada)
- [ ] Documento interno com passo-a-passo de migração de número (SMS, Display Name, etc.)
- [ ] Combinado com donos das barbearias: "se acontecer X, vamos precisar de 1h de janela no seu número, ok?"

O código em si (Fase 1) leva 3-5 dias e pode ser feito **na hora**, não é o gargalo. O gargalo é aprovação Meta — e essa dá pra resolver **agora, sem custo, guardado no bolso**.
