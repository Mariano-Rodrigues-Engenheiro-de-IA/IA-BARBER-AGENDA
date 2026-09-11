# Monitor 24h — IA que audita o atendimento das barbearias

Uma segunda IA (auditora) revisa, de forma contínua, cada atendimento que envolveu ferramenta de agenda/cliente, compara pedido × resposta × retorno real da ferramenta, e registra apenas erros com prova citada. Ela não corrige nada e não opina sobre causa.

Começa pelas barbearias em AppBarber (9Cinco), com liga/desliga por barbearia para expandir depois.

## Como funciona

1. **Seleção do que auditar** — a cada 5 minutos, um processo pega os atendimentos recentes que tiveram pelo menos uma ferramenta de agendar, cancelar, remarcar, buscar cliente ou cadastrar cliente. Conversas de saudação sem ferramenta são marcadas como "não auditáveis" e ignoradas (custo zero).
2. **Montagem do dossiê** — para cada atendimento: mensagem do cliente, últimas mensagens da conversa, resposta final enviada, e a lista real de chamadas de ferramenta com argumentos, sucesso/erro e código de erro (ex.: 429, 422, limite de agendamentos).
3. **Julgamento** — a IA auditora recebe o dossiê e devolve, por categoria, um veredito com trecho exato da conversa + trecho exato do retorno da ferramenta. Categorias:
   - Completude do agendamento (serviços a menos, pessoas a menos)
   - Cancelamento/remarcação correta
   - Comunicação (o que disse ≠ o que fez)
   - Erro técnico mascarado (ferramenta falhou e a IA seguiu como se tivesse dado certo)
4. **Regra de prova** — achado sem trecho da conversa **e** sem trecho do retorno da ferramenta é descartado automaticamente antes de ser gravado. Nada entra no painel por opinião.
5. **Gravação** — cada achado vira um registro com barbearia, telefone, data, categoria, gravidade, resumo e as duas evidências, ligado ao atendimento original.

## Painel "Monitor da IA" (tela própria no menu admin)

- Cartão por barbearia com **três semáforos separados** (completude, cancelamento/remarcação, comunicação) — sem nota única.
- Filtro de período (hoje, 7 dias, 30 dias, intervalo livre).
- Percentual de acerto por barbearia e por categoria no período, com total de atendimentos auditados.
- Lista de atendimentos com problema, filtrável por barbearia/categoria/gravidade.
- Ao abrir um achado: conversa completa, resposta final, chamadas de ferramenta e as evidências citadas destacadas.
- Ação humana: marcar como "procede", "falso alarme" ou "resolvido" — o índice de falso alarme fica visível para medir a confiança na auditora.

## Validação antes de ligar em produção

Modo sombra primeiro: a auditora roda sobre os casos reais já documentados hoje (Ricardo Trento, Igor Silva, Mariano/Lucas, corte+sobrancelha, 429 mascarado como "sem vaga", cancelamento com erro não tratado) mais uma amostra de atendimentos corretos. Só ativo depois de confirmar que ela acusa cada caso ruim com prova e não acusa os atendimentos corretos.

## Detalhes técnicos

- Fonte de dados: `agent_logs` (`user_message`, `ai_response`, `tool_calls`, `errors`) + `chat_messages` para o contexto da conversa. Nenhuma mudança no `whatsapp-webhook` — o monitor é estritamente leitura, isolado do fluxo de atendimento.
- Nova Edge Function `audit-monitor` (agendada por `pg_cron` a cada 5 min, lote pequeno, `verify_jwt = false` com segredo próprio), separada por arquivo dos providers.
- Nomes propostos para confirmação (nada é criado sem seu ok):
  - Tabela de achados: `ai_audit_findings`
  - Tabela de controle do que já foi auditado: `ai_audit_runs`
  - Chave em `agent_settings`: `ai_monitor_enabled`
- RLS: leitura/escrita apenas admin/staff com módulo `ai-monitor`; `service_role` para a função. GRANTs explícitos na mesma migration.
- Modelo da auditora via Lovable AI, saída estruturada obrigatória (categoria, veredito, trechos de evidência); resposta sem evidência é descartada em código, não no prompt.
- Rota `/ai-monitor` no admin + item no menu, seguindo o padrão das telas existentes.

## Fora de escopo agora

- Providers Trinks, OneBeleza, Frizzar e Bemp (a estrutura já nasce com o campo de provider; ligar depois).
- Qualquer correção automática pela auditora.
