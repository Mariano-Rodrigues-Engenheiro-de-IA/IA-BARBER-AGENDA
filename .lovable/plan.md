## Objetivo

A IA "se perde" em informações de contexto que deveria ter sempre frescas: hora atual, período do dia, dia da semana, nome do cliente (WhatsApp + cadastro), telefone, há quanto tempo a conversa parou, etc. Vou reforçar tudo isso de uma vez no `buildSystemPrompt` da `whatsapp-webhook` — vale para Trinks, OneBeleza, Frizzar, Bemp, Zaylo e None.

## O que já existe hoje

- Data/hora de Brasília + dia da semana + calendário de 14 dias (linhas 5684–5689).
- Regras anti-erro de data (linhas 5691–5724).
- `explicitClientName` (cliente disse o nome) e `leadName` (CRM) usados (linhas 5650–5658).
- `senderName` (pushName do WhatsApp) é **coletado e passado** pro `buildSystemPrompt`, mas **nunca usado no prompt** (bug latente).

## Gaps identificados (causam confusão)

1. **Hora atual pouco visível.** A IA vê uma string longa `2026-06-04T16:23:45` mas não tem destaque para "AGORA SÃO 16:23". Causa o caso "já fechamos às 19h30" mesmo sendo 16h.
2. **Período do dia ausente.** Sem "manhã / tarde / noite" explícito → saudações fora de hora ("bom dia" às 22h) e raciocínio errado sobre fechamento.
3. **Comparação com horário de funcionamento não é regrada.** O prompt nem instrui a IA a comparar a hora atual com o horário do estabelecimento antes de dizer "já fechamos".
4. **PushName do WhatsApp ignorado.** Mesmo quando útil como contexto secundário (ex: gênero plausível, saudação informal), a IA não recebe.
5. **Telefone está cru.** Falta dizer DDD/região para a IA não estranhar formatos.
6. **"Há quanto tempo a conversa parou" não é calculado.** A IA tem regra (linhas 5699–5705) mas não recebe o gap real em horas/minutos desde a última mensagem do cliente — fica adivinhando pelo timestamp das mensagens.
7. **Sem resumo "o que já sabemos do cliente"** num bloco único — hoje está espalhado.

## Plano de mudança (um único arquivo)

Arquivo: `supabase/functions/whatsapp-webhook/index.ts`

### 1. Ampliar `getBrasiliaDate()` (linha 5613)
Adicionar campos derivados:
- `timeHHMM` ("16:23"),
- `periodOfDay` ("madrugada" 0–5, "manhã" 6–11, "tarde" 12–17, "noite" 18–23),
- `greeting` ("bom dia" / "boa tarde" / "boa noite"),
- `weekendOrWeekday` ("fim de semana" | "dia útil"),
- `isoBrasilia` com offset `-03:00`.

### 2. Calcular `lastClientGapMinutes` em `callAIAgent` (perto da linha 3577)
Olhar o último item do `history` com `role === "user"` (ignorando a mensagem atual) e calcular `Date.now() - created_at` em minutos. Passar pro `buildSystemPrompt`.

### 3. Reescrever o bloco "📅 DATA E HORA ATUAL" (linhas 5684–5689)
Novo formato, em destaque, no topo do prompt:
```
## ⏰ CONTEXTO TEMPORAL (LEIA ANTES DE QUALQUER RESPOSTA)
- AGORA: 16:23 (tarde) — {dia-da-semana}, {dd/mm/aaaa}
- Saudação adequada agora: "boa tarde"
- Período: tarde | Tipo de dia: dia útil
- Gap desde a última mensagem do cliente: 3h12 (ou "primeira mensagem")
- Calendário próximos 14 dias: …
```

Regras adicionadas (curtas, em bullets):
- "Antes de dizer 'já fechamos' / 'ainda estamos abertos', compare a HORA AGORA com o horário do estabelecimento na base de conhecimento. Se AGORA < horário de fechamento, NÃO diga que fechou."
- "Use a saudação coerente com o período acima. NUNCA 'bom dia' à tarde/noite."
- "Se o gap > 12h, releia o histórico antes de assumir que 'amanhã'/'hoje' antigos ainda valem (regra que já existe, agora com o gap real exibido)."

### 4. Novo bloco "👤 IDENTIDADE DO CLIENTE" (substitui o atual `nameBlock`, linhas 5650–5658)
Consolida tudo num lugar:
```
## 👤 IDENTIDADE DO CLIENTE
- Telefone: +55 61 98301-2868 (DDD 61 = Brasília/DF)
- Nome confirmado pelo cliente nesta conversa: {explicit} | (vazio)
- Nome no CRM/cadastro: {leadName} | (não cadastrado)
- Nome exibido no WhatsApp (pushName): {senderName} | (não disponível)
- Nome a usar nas mensagens: {firstName escolhido} | (não use nome)
```
Regras:
- Prioridade pra falar com o cliente: `explicit` > `leadName` > nenhum. **Nunca** use pushName pra se dirigir ao cliente nem pra cadastrar (mantém regra atual).
- pushName serve só como **dica fraca** (ex: se cliente perguntar "você sabe meu nome?" e tudo mais estiver vazio, pode dizer "tenho um 'Fulano' aqui, é você?" — pedindo confirmação).
- Bloqueia pushName claramente inválido (emojis, números, símbolos) via `sanitizeClientName` / `isUsableClientName` que já existem.

### 5. Pequeno cleanup
- Remover trecho duplicado de "📱 TELEFONE DO CLIENTE" (linhas 5728–5730), já que o telefone passa para o novo bloco unificado.
- Mover o calendário de 14 dias logo após o novo bloco temporal pra manter agrupado.

## Por que isso resolve

- Hora + período explícitos → corta o erro de "fechamos às 19h30" às 16h e saudações fora de hora.
- Gap real desde a última mensagem → reforça a regra de continuidade que já existe (linhas 5699–5705) com dado concreto.
- Bloco único de identidade → IA para de "esquecer" o nome entre turnos e para de tentar usar pushName cru pra cadastrar.
- Mudança fica 100% no `buildSystemPrompt` (compartilhado por todos os provedores), então **vale automaticamente para todas as barbearias**, sem mexer em prompt customizado de tenant.

## Não muda

- Prompts customizados (`tenant.agent_system_prompt`) seguem intactos — vão acima/abaixo dessa base como hoje.
- Ferramentas, providers, RLS, tabelas: nenhuma alteração.
- Não toco em comportamento de envio nem em débounce.
