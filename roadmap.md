# Roadmap

- [x] Auditar todos os guards e o fluxo AppBarber contra situações cotidianas amplas
- [x] Projetar estado determinístico de intenção, execução e pendências sem depender de palavras-chave
- [x] Isolar o núcleo de reconciliação e a precedência para impedir interferências
- [x] Corrigir confirmação parcial, múltiplas pessoas/serviços e repetição de resultado incerto
- [x] Adicionar matriz inicial de testes com múltiplas pessoas, dedupe, incerteza e precedência
- [x] Validar e publicar somente whatsapp-webhook em modo sombra
- [x] Corrigir roteamento e anti-eco de mensagens manuais da barbearia

## Próxima etapa condicionada aos dados de sombra
- [ ] Revisar divergências reais do extrator estruturado antes de torná-lo bloqueante em todos os guards
- [ ] Ampliar testes fim a fim dos dispatchers legados ainda presos ao handler principal
- [x] Corrigir falso MultiBooking do AppBarber causado por slots antigos em pedido único
