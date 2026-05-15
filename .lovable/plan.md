
# Follow-ups de Primeiro Contato (Tráfego Pago)

## Objetivo
Quando um lead chega via tráfego pago (identificado por palavra-chave na 1ª mensagem), disparar uma sequência de follow-ups configurável. Se o lead responder em qualquer etapa, a sequência é interrompida. Tudo monitorado num painel completo.

## Análise da proposta + sugestões (experiência)

Sua proposta está sólida. Pontos que sugiro reforçar:

1. **Detecção do lead de tráfego** — além de palavra-chave exata, suportar:
   - Lista de palavras-chave (não só uma) com match case-insensitive
   - Match parcial OU regex (ex: "quero saber mais", "vi o anúncio", "instagram")
   - Campo opcional **"qualquer primeira mensagem"** (catch-all) para barbearias que rodam tráfego intenso e querem follow-up em todo lead novo
   - Salvar a `keyword` que casou no lead (vira métrica: qual criativo converte mais)

2. **Gatilho preciso** — disparar a sequência quando:
   - É a 1ª interação do telefone com o tenant (não tem histórico)
   - A mensagem casa com a regra de keyword (ou catch-all está ativo)
   - A IA responde normalmente
   - **Cancela tudo** assim que o lead enviar QUALQUER nova mensagem

3. **Sequência reciclável (template)** — em vez de configurar 4 mensagens travadas:
   - Criar conceito de **"Cadência"** (template reutilizável): nome + lista ordenada de etapas `[{ ordem, delay_minutes, mensagem }]`
   - Cadência default já vem com 4 etapas pré-preenchidas
   - Você pode adicionar/remover etapas, reordenar (drag), editar texto e intervalo
   - **Reciclável**: a mesma cadência pode ser usada em vários gatilhos futuros (não só tráfego — depois "lead frio", "pós-atendimento" etc.)

4. **Janelas de horário** (sugestão forte) — não enviar follow-up às 3h da manhã. Definir horário comercial (ex: 8h-21h). Se o disparo cair fora, agenda pro próximo horário válido.

5. **Anti-spam / segurança**:
   - Limite máximo de etapas por sequência (ex: 10)
   - Intervalo mínimo entre etapas (ex: 5 min)
   - Não disparar se o tenant estiver `inactive`
   - Se a IA já respondeu o lead e ele respondeu de volta antes do 1º follow-up, cancela

6. **Métricas no painel** — completas:
   - Total de leads de tráfego identificados (por período + por keyword)
   - Sequências em andamento / pausadas (lead respondeu) / completadas (4/4 enviadas sem resposta) / convertidas (lead respondeu após follow-up X)
   - Taxa de resposta por etapa (qual mensagem mais converte)
   - Tempo médio até a primeira resposta
   - Funil visual: 100 leads → 60 responderam após etapa 1 → 25 após etapa 2 ...
   - Drill-down por lead: ver a timeline completa (chegou às 14h, IA respondeu, etapa 1 enviada às 14h30, etapa 2 às 15h, lead respondeu às 15h05 → convertido)

## Estrutura técnica

### 1. Banco de dados (migration)

**Nova tabela `follow_up_sequences`** (templates reutilizáveis):
- `tenant_id`, `name`, `trigger_type` (`first_contact_traffic` por enquanto, expansível)
- `trigger_config` jsonb: `{ keywords: string[], match_mode: "any"|"all"|"regex", catch_all: bool }`
- `business_hours` jsonb: `{ enabled, start: "08:00", end: "21:00", timezone: "America/Sao_Paulo" }`
- `enabled` bool

**Nova tabela `follow_up_steps`**:
- `sequence_id`, `step_order`, `delay_minutes` (do passo anterior, ou do gatilho se for o 1º), `message`

**Estender `follow_ups`** (agendamentos individuais):
- `sequence_id` uuid (nullable — mantém compat com follow-ups antigos)
- `step_order` int
- `matched_keyword` text (qual keyword disparou — vira métrica)
- `cancelled_at` timestamptz, `cancel_reason` text (`lead_replied`, `tenant_inactive`, etc.)

Manter `follow_ups` atual funcionando — apenas estender.

### 2. Edge function `whatsapp-webhook`

Ao processar uma mensagem de usuário:

```text
SE é primeira interação do phone+tenant
E existe sequence ativa do tipo "first_contact_traffic"
E (catch_all OU mensagem casa keywords)
ENTÃO:
  - registra `matched_keyword` no log
  - agenda APENAS a etapa 1 (próximo follow_up_at = agora + step1.delay,
    respeitando business_hours)
  - salva sequence_id + step_order=1 no follow_ups

SE NÃO é primeira interação E existem follow_ups pending/sent dessa sequence
ENTÃO:
  - cancela todos os pending dessa sequence (cancelled_at, reason="lead_replied")
  - marca os já enviados como "responded" (nova coluna de status ou usa confirmed)
```

### 3. Edge function `process-followups`

Quando dispara uma etapa N:
- Envia mensagem
- Se existe etapa N+1 na sequence E lead ainda não respondeu → agenda N+1 com delay configurado
- Se é a última etapa → marca sequência como `completed`
- Tudo respeita business_hours

### 4. UI

**Aba "Cadências" no TenantForm** (CRUD de templates):
- Card por cadência: nome, gatilho, status, qtd de etapas
- Editor: gatilho + lista drag-and-drop de etapas (cada uma com `delay`, `mensagem`, preview)
- Templates pré-prontos: "Tráfego pago — 4 etapas (padrão)", customizáveis

**Painel `/follow-ups` reformulado**:
- Filtros: período, tenant, sequence, keyword
- Cards de métricas: leads captados, sequências ativas/canceladas/completadas, taxa de resposta global, tempo médio até resposta
- Funil por etapa (gráfico de barras decrescentes)
- Tabela de leads: telefone, keyword, etapa atual, status, última atualização → clicar abre timeline
- Modal timeline: linha do tempo com cada etapa enviada + resposta do lead

## Entregáveis (ordem de implementação)

1. Migration: `follow_up_sequences`, `follow_up_steps`, novas colunas em `follow_ups`
2. Backfill: criar uma sequence default por tenant ativo (opcional, ou só ao usuário criar)
3. Webhook: lógica de detecção de keyword + agendamento da etapa 1 + cancelamento ao receber resposta
4. `process-followups`: lógica de encadeamento + business_hours
5. UI Cadências (TenantForm)
6. Painel Follow-ups reformulado (métricas + funil + timeline)

## Decisões que preciso de você

- **Business hours**: implemento (8h-21h default) ou pula por enquanto?
- **Catch-all opcional** (todo lead novo entra na sequência) você quer? Se sim, fica como toggle por cadência.
- **Múltiplas cadências por tenant** ou só uma de "primeiro contato" por enquanto? (recomendo permitir múltiplas desde já — custo é zero e abre futuro).
- **Compatibilidade**: mantenho follow-ups antigos (`after_link_sent`, `after_no_reply`) funcionando ou migro tudo pro novo modelo de cadência?
