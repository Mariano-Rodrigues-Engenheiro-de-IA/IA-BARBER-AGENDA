# Roadmap

## Conferência e publicação — 21/10 (commit a219968, main 81f1c17)
- [x] Sincronizar main 81f1c17 — marcadores trinksSenderLocalPhone, resolveProfileNameForRegistration e profileNameToRegister presentes
- [x] Conferir a219968 contra logs reais: bloqueios "Sergio" (12:46 UTC) e "nicolasdaniel57035" (11:59 UTC) confirmados; telefone errado 169999628080 apareceu 1x; demais buscar_cliente com telefone correto
- [x] Verificar prompts Thallys/Bendita: TIPO 2 proíbe cadastro de acompanhante (usa clienteId da conversa); presente da Bendita escala humano — ajuste A não quebra fluxo legítimo
- [x] One Beleza idêntica; nome inventado segue barrado; perfil sem nome utilizável segue escalando
- [x] npx vitest run: 171 aprovados, 17 ignorados; deno check OK
- [x] Publicar somente whatsapp-webhook — deploy 21/10 17:37 UTC (14:37 Brasília), sem erro; segredo inválido rejeitado com 401

## Conferência e publicação — 20/10
- [x] Conferir commits 10b40ed e 2be833e contra código e casos reais
- [x] Aplicar apenas nome sequencial mantendo perfil, cache antigo só em 429/502/503/504 e textos de bloqueio/dica; não editar prompts nem regras protegidas
- [x] Ampliar testes (nome separado e cache com 401), executar suíte e validar sintaxe — 162 passaram, 17 ignorados; Deno OK
- [x] Publicar somente whatsapp-webhook — fonte c598f817, deploy concluído entre 19:03:02 e 19:03:24 UTC, sem erro; requisição com segredo inválido rejeitada com 401
- [ ] Confirmar chegada do commit c598f817 à main remota — sincronização gerenciada pelo Lovable; referência main local ainda em a00c8ef

- [x] Auditar todos os guards e o fluxo AppBarber contra situações cotidianas amplas
- [x] Projetar estado determinístico de intenção, execução e pendências sem depender de palavras-chave
- [x] Isolar o núcleo de reconciliação e a precedência para impedir interferências
- [x] Corrigir confirmação parcial, múltiplas pessoas/serviços e repetição de resultado incerto
- [x] Adicionar matriz inicial de testes com múltiplas pessoas, dedupe, incerteza e precedência
- [x] Validar e publicar somente whatsapp-webhook em modo sombra
- [x] Corrigir roteamento e anti-eco de mensagens manuais da barbearia
- [x] Fechar corrida da IA OFF antes do envio final e em ferramentas de saída

## Próxima etapa condicionada aos dados de sombra
- [ ] Revisar divergências reais do extrator estruturado antes de torná-lo bloqueante em todos os guards
- [ ] Ampliar testes fim a fim dos dispatchers legados ainda presos ao handler principal
- [x] Corrigir falso MultiBooking do AppBarber causado por slots antigos em pedido único
- [x] Remover aviso genérico de instabilidade em respostas vazias e preservar silêncio seguro
- [x] Atualizar a logo Zaylo na tela de login e nos painéis administrativo e de colaboradores

## Monitor 24h — investigação solicitada em 14/09
- [x] Conferir A1–A7 no código, histórico e registros reais
- [x] Apresentar diagnóstico próprio antes de alterar produção
- [x] Preparar plano de correção com custo e critérios de validação
- [x] Plano aprovado pelo usuário; modelo do monitor definido: gpt-5-mini via OpenAI direta
- [x] Implementar correções do monitor: OpenAI direta gpt-5-mini, fila de reprocessamento, triagem determinística (silent_mode, guard detected_, ação afirmada), calendário de 14 dias no dossiê, descartes com motivo, alerta de saúde (3 erros seguidos), prompt atualizado no código e no painel
- [x] Validar casos de aceite: 555ef6cb auditado e sinalizado como acao_afirmada_nao_executada; 10 casos de falso alarme de data reprocessados sem reabrir; 53 turnos de modo silencioso devolvidos à fila
- [~] Reprocessamento dos 77 erros de 14/09: automático pela fila nos próximos ciclos do agendador (~1-2h para drenar)
- [ ] Acompanhar um dia completo: status=error <1%, zero credit_limit_reached, custo diário dentro do teto
- [x] Corrigir corrida da IA OFF: impedir escalada que delega agendamento e distinguir etiqueta aplicada pela própria transferência silenciosa
- [x] Corrigir caso 553dc6b9: detectar "já deixei reservado" sem escrita e reinjetar sem depender de snapshot
- [x] Preservar no AppBarber o serviço/profissional/data escolhidos a partir dos slots oferecidos
- [ ] Bemp: corrigir confirmação falsa após pergunta do atendente (plano aguardando aprovação)
