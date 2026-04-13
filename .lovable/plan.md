

# Follow-ups Múltiplos e Configuráveis por Tenant (Todos os Providers)

## Resumo

Transformar o sistema de follow-up atual (single, só para provider "none") em um sistema de **múltiplos follow-ups configuráveis** por tenant, funcionando para **todos os providers** (Trinks, One Beleza, None).

## O que muda

Hoje existe 1 follow-up fixo por tenant (ativado/desativado, delay, mensagem). O novo sistema permite criar **N follow-ups** por tenant, cada um com:

- **Nome** (ex: "Pós-agendamento", "Lembrete de retorno")
- **Gatilho** — quando dispara:
  - `after_booking` — após agendamento criado (criar_agendamento, agendar)
  - `after_link_sent` — após envio de link (comportamento atual)
  - `after_conversation` — X minutos após última interação sem agendamento
- **Delay** em minutos
- **Mensagem** personalizada
- **Ativo/Desativado** individual

## Mudanças Técnicas

### 1. Estrutura de dados (agent_settings.follow_ups)

Migrar de `agent_settings.follow_up` (objeto único) para `agent_settings.follow_ups` (array):

```json
{
  "follow_ups": [
    {
      "id": "uuid",
      "name": "Pós-agendamento",
      "trigger": "after_booking",
      "delay_minutes": 60,
      "message": "Oi! Seu agendamento foi confirmado...",
      "enabled": true
    },
    {
      "id": "uuid",
      "name": "Lembrete link",
      "trigger": "after_link_sent",
      "delay_minutes": 30,
      "message": "Conseguiu agendar pelo link?",
      "enabled": true
    }
  ]
}
```

Nenhuma migração de banco necessária — os dados ficam no JSONB existente.

### 2. UI no TenantForm.tsx (aba "Integração API")

- Remover seção atual de follow-up único (só aparece em "none")
- Criar nova seção **"Follow-ups"** visível para **todos os providers**
- CRUD de follow-ups: adicionar, editar, remover
- Cada item mostra: nome, gatilho (select), delay (input number), mensagem (textarea), switch ativo
- Compatibilidade: ao carregar, se existir `follow_up` antigo (formato single), migrar automaticamente para o array `follow_ups`

### 3. Edge Function whatsapp-webhook

- Remover lógica antiga `if (provider === "none")` para follow-ups
- Após processamento do agente, verificar **todos os follow-ups ativos** do tenant
- Para cada follow-up, checar se o gatilho foi atingido:
  - `after_booking`: detectar se alguma tool de agendamento foi chamada (criar_agendamento, agendar)
  - `after_link_sent`: detectar enviar_link_agendamento ou URL na resposta
  - `after_conversation`: agendar se nenhum agendamento foi feito na conversa
- Inserir na tabela `follow_ups` com o `follow_up_message` correspondente

### 4. Edge Function process-followups

- Sem mudanças necessárias — já processa qualquer registro pendente na tabela `follow_ups`

### 5. Migração de dados legados

- No carregamento do TenantForm: se `agent_settings.follow_up` (singular) existir, converter para `follow_ups[]` (array)
- No webhook: ler `follow_ups` (array), fallback para `follow_up` (singular) para compatibilidade

## Arquivos Afetados

| Arquivo | Mudança |
|---------|---------|
| `src/pages/TenantForm.tsx` | Nova UI CRUD de follow-ups, remover seção antiga |
| `supabase/functions/whatsapp-webhook/index.ts` | Lógica multi-trigger para todos os providers |
| `.lovable/memory/features/ai-agent.md` | Atualizar documentação |

