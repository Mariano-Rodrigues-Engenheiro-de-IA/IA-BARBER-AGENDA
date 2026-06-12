## Problema

Hoje, quando o cliente volta a responder dias (ou semanas) depois, a IA continua a conversa como se fosse o mesmo dia: reusa horários, confirmações e contexto antigo. O histórico enviado ao modelo é apenas `{role, content}` — sem data/hora —, então o modelo não percebe a virada de dia.

Já existe um sinal parcial (`lastClientGapMinutes` + uma regra "gap >12h" no prompt), mas ele só fala da última mensagem do **cliente** e é uma menção solta. Não cobre a última mensagem do **humano/IA**, nem força reset de contexto.

## Solução (3 camadas)

### 1. Timestamps reais no histórico enviado ao modelo
Em `callAIAgent`, ao montar `messages` a partir de `history`, prefixar cada mensagem com um marcador interno datado em Brasília, ex:

```
[12/06 14:03] Cliente: ...
[12/06 14:05] IA: ...
[19/06 09:11] [ATENDENTE HUMANO]: ...
```

Para isso, a query de histórico (linha ~2066) passa a selecionar `created_at` e a transformação para `messages` (linha ~4285) injeta o prefixo no `content`. Mantém role original (`user`/`assistant`) para o modelo. O prefixo é **interno** e cai na mesma regra já existente que proíbe a IA de reproduzir colchetes na resposta ao cliente.

### 2. Bloco de "estado temporal" no system prompt
Em `buildSystemPrompt`, além do `gapStr` atual, calcular e injetar um bloco no topo:

```
## ⏰ ESTADO TEMPORAL DESTA INTERAÇÃO
- Agora (Brasília): 12/06/2026 14:32 (sexta-feira)
- Última mensagem do cliente antes desta: 05/06 10:14 (gap: 7 dias)
- Última mensagem sua (IA): 05/06 10:15
- Última mensagem do atendente humano: 05/06 11:00
- Status da sessão: NOVA SESSÃO (gap ≥ 8h ou dia diferente)
```

O flag `NOVA SESSÃO` é derivado por: gap do cliente ≥ 8h **ou** data calendário diferente de hoje (Brasília).

### 3. Nova regra global — "Virada de dia / conversa antiga"
Adicionar seção `## 📅 REGRA GLOBAL — VIRADA DE DIA / CONVERSA ANTIGA` ao prompt, aplicada a todos os providers:

- Antes de responder, SEMPRE comparar "Agora" com a data da última troca real.
- Se `Status = NOVA SESSÃO`:
  - **Não** dar continuidade automática ao tópico anterior (não reconfirmar agendamento antigo, não retomar fluxo de escolha de horário/serviço pendente, não enviar link/PIX que já tinha sido oferecido).
  - Tratar a mensagem atual como uma **nova interação**: cumprimento curto adequado ao horário + perguntar como pode ajudar **agora**.
  - Se a mensagem atual referenciar claramente o assunto antigo (ex: "pode confirmar aquele horário?"), **revalidar** os dados: reconsultar disponibilidade/preço/cadastro via ferramentas antes de prometer qualquer coisa — horários, valores e ofertas anteriores estão **expirados**.
- Horários relativos ("hoje", "amanhã", "sexta") do histórico antigo são **inválidos**; só vale a data absoluta. Se precisar mencionar, traduzir para a referência relativa correta em relação a "Agora".
- Se a última mensagem foi do humano/IA e ficou sem resposta por dias, não "completar" o assunto antigo — começar do zero educadamente.

Remover a regra solta atual de "gap >12h" (linha ~6850) e consolidar dentro dessa nova seção para evitar conflito.

## Arquivos afetados

- `supabase/functions/whatsapp-webhook/index.ts`
  - query de histórico (~2066): incluir `created_at`
  - montagem de `messages` (~4283): prefixar timestamp Brasília por mensagem
  - cálculo de gaps (~4245): adicionar gap do humano e da própria IA + flag `isNewSession`
  - `buildSystemPrompt` (~6698): receber novos campos, injetar bloco "Estado temporal" e a nova regra global; remover regra duplicada de gap >12h

Sem mudanças de schema, sem mudanças de UI, sem mudanças em outras edge functions.

## Validação

1. Conferir em `agent_logs` uma execução nova: o prompt deve conter o bloco "Estado temporal" e mensagens do histórico com prefixo `[DD/MM HH:MM]`.
2. Cenário real: pegar conversa com gap de vários dias e simular nova mensagem do cliente — IA deve cumprimentar e perguntar o que precisa, não retomar o agendamento antigo.
3. Cenário same-day: gap curto — IA deve continuar normalmente (sem flag NOVA SESSÃO).
