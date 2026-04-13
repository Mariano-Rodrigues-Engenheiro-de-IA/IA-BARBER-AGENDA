

# Plano: Dashboard de Métricas por Tenant + Follow-ups Personalizados

## 1. Sobre Follow-ups Personalizados

A estrutura atual (múltiplos follow-ups com triggers genéricos) já permite bastante customização, mas entendo que você precisa de **lógica específica por projeto** — tipo "se o cliente parou na etapa X, faz Y". Isso exige condições mais complexas que os 3 triggers atuais não cobrem.

**Proposta: Follow-ups com condições customizadas via prompt**

Em vez de remover tudo, manter a infraestrutura (tabela `follow_ups`, `process-followups`) mas mudar a abordagem:

- **Cada follow-up ganha um campo "condição" em texto livre** — você descreve quando ele deve disparar (ex: "cliente perguntou sobre prótese mas não agendou", "cliente pediu preço e não respondeu mais")
- **A IA avalia a condição** ao final de cada conversa — ela analisa o histórico e decide quais follow-ups aplicam
- Mantém: nome, delay, mensagem, ativo/desativado
- Remove: triggers fixos (after_booking, after_link_sent, after_conversation)
- Resultado: você me pede no chat "cria um follow-up que dispara quando X" e eu adiciono com a condição certa

Isso dá flexibilidade total sem precisar de código novo para cada regra.

---

## 2. Dashboard de Follow-ups (nova página)

Rota: `/follow-ups` — link na sidebar

**Métricas globais (cards no topo):**
- Total enviados | Confirmados | Pendentes | Expirados

**Tabela por tenant:**
- Nome do tenant | Enviados | Confirmados | Pendentes | Taxa de confirmação
- Filtro por período (7d, 30d, todos)

**Dados:** query na tabela `follow_ups` agrupando por tenant_id + status

---

## 3. Dashboard por Tenant (nova página)

Rota: `/tenants/:id/dashboard` — botão "Dashboard" no card do tenant

**Métricas (cards):**
- Clientes atendidos (unique phone_numbers)
- Total de mensagens trocadas
- Agendamentos realizados (tool_calls com criar_agendamento/agendar)
- Links enviados (tool_calls com enviar_link_agendamento)
- Follow-ups enviados / confirmados

**Gráfico de atividade:**
- Mensagens por dia (últimos 30 dias) — gráfico de barras com recharts

**Filtro de período:** 7 dias, 30 dias, personalizado

**Dados:** queries em `chat_messages`, `agent_logs` (tool_calls JSONB), `follow_ups`

---

## Arquivos Afetados

| Arquivo | Mudança |
|---------|---------|
| `src/pages/FollowUpsDashboard.tsx` | **Novo** — dashboard de follow-ups |
| `src/pages/TenantDashboard.tsx` | **Novo** — dashboard por tenant |
| `src/pages/TenantForm.tsx` | Alterar UI de follow-ups: remover triggers fixos, adicionar campo "condição" |
| `src/App.tsx` | Novas rotas |
| `src/components/AdminLayout.tsx` | Link "Follow-ups" na sidebar |
| `supabase/functions/whatsapp-webhook/index.ts` | Lógica de avaliação de condições via IA |
| `.lovable/memory/features/ai-agent.md` | Atualizar docs |

