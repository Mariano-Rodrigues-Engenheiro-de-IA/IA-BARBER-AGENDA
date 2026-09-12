---
name: Monitor 24h da IA (auditoria de atendimentos)
description: Segunda IA que audita atendimentos com ferramentas de agenda/cliente, grava achados com prova e alimenta a tela /ai-monitor
type: feature
---
- Edge Function isolada `audit-monitor` (nunca mexer no whatsapp-webhook por causa dela).
  Auth fail-closed: `x-cron-secret` = CRON_SECRET, bearer service-role, ou admin autenticado.
- Roda por pg_cron `ai-audit-monitor-10min` (*/10, 144x/dia), body copiado do job de follow-ups.
- Só audita turnos cujo `tool_calls` tem criação/cancelamento/remarcação/cliente; o resto entra como `skipped_no_tools`.
- Dossiê = conversa anterior (14 msgs) + mensagem do turno + resposta final + reação posterior do cliente (4 msgs) + retorno real das ferramentas + errors.
- Modelo auditor: `google/gemini-3.8-flash` com json_schema estrito. Categorias: completude_agendamento, cancelamento_remarcacao, comunicacao, erro_tecnico_mascarado.
- Trava determinística em `auditor.ts`: todo achado precisa citar trecho real da conversa E do bloco de ferramentas (normalização sem acento + janelas de 4 palavras, 80% de match). Sem prova → descartado (`discarded_count`).
- Tabelas: `ai_audit_runs` (1 por agent_log, unique) e `ai_audit_findings` (review_status: open/valid/false_alarm/resolved).
- Ativação por tenant: `tenants.agent_settings.ai_monitor_enabled = true`. Hoje só 9Cinco (AppBarber).
- Tela `/ai-monitor` (módulo staff `ai-monitor`): semáforos por categoria por empresa, filtros de período/empresa/categoria/status, botão "Auditar agora", detalhe com as duas provas.
- A auditora NÃO corrige nada e não sugere causa raiz — só aponta divergência com prova.
- Prompt da auditora vive em `_shared/provider-prompts.ts` (`buildAuditorPromptSection`, provider `auditor`) e é editável na aba Prompts; override em `provider_prompts` (>200 chars) vence o padrão.
- Escopo do julgamento: só erro concreto e provado na agenda/API (disse-e-não-fez sem ID real, dado errado, incompleto, erro de ferramenta mascarado, disponibilidade inventada, ferramenta não chamada). Qualidade/tom nunca é achado; em dúvida, não reporta.
