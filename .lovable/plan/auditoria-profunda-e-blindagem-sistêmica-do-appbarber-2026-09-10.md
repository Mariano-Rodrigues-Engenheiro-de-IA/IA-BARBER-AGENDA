# Auditoria profunda e blindagem sistêmica do AppBarber

## Objetivo
Tratar o atendimento completo de uma barbearia, não um caso específico. O sistema deve compreender pedidos livres, convertê-los em um estado estruturado e impedir deterministicamente que a resposta final contradiga o que foi realmente executado.

Não é possível prometer ausência absoluta de falhas futuras da API ou do modelo. A garantia implementável é: quando o sistema não comprovar que cada ação pedida foi concluída, ele não poderá afirmá-la como concluída, repetir uma ação incerta nem deixar um guard anular outro silenciosamente.

## Arquitetura proposta

A linguagem natural continuará sendo interpretada por IA, porque pedidos cotidianos não cabem com segurança em uma coleção de palavras-chave. Depois dessa interpretação, o código assume o controle:

```text
Conversa completa
      |
      v
Extrator de intenção estruturada
(pessoas, serviços, horários, ações e referências)
      |
      v
Estado persistido da solicitação
(pedido | executado | pendente | falhou | incerto)
      |
      v
Ferramentas AppBarber + ledger de resultados reais
      |
      v
Reconciliador determinístico
      |
      +--> Guards independentes produzem decisões
      |
      v
Árbitro de precedência impede conflitos
      |
      v
Resposta permitida, corrigida ou bloqueada
```

A IA identifica intenção e ambiguidade; o código compara o estado estruturado com resultados reais. Regexes ficam apenas como sinais auxiliares rápidos, nunca como prova suficiente de conclusão.

## Implementação

### 1. Inventário completo antes da correção
- Mapear todos os caminhos AppBarber de criação, consulta, confirmação, cancelamento, remarcação, recuperação, dedupe, cadastro e resposta final.
- Para cada guard, documentar entrada, saída, precedência, efeito colateral e quais estados pode ou não alterar.
- Auditar cruzamentos: PhantomConfirmation, PhantomCancel, Cancel, MultiBooking, Reschedule, StaleConfirmation, ArgGuard, NameGuard, ownership, dedupe e fallback.
- Localizar todos os caminhos fail-open, clamps que reduzem quantidade, respostas sobrescritas e recuperações que repetem ações.

### 2. Estado estruturado da solicitação
- Representar cada item solicitado separadamente: pessoa, serviço, data, horário, profissional, ação desejada e relação com outro item.
- Persistir no estado já existente da conversa os itens pedidos, concluídos, pendentes, falhos e incertos; não criar tabela nova.
- Permitir pedidos com uma ou várias pessoas, serviços, horários e profissionais, inclusive combinações misturadas.
- Associar cada resultado real da API ao item correspondente; contagem sozinha não será prova de conclusão.
- Quando a interpretação estiver ambígua, marcar o campo como ambíguo e perguntar somente o dado necessário.

### 3. Interpretação ampla de intenção
- Substituir a dependência decisiva de palavras-chave por extração estruturada sobre a conversa completa.
- Usar um verificador de IA separado quando regras determinísticas não conseguirem resolver linguagem ambígua; sua saída será validada por esquema e nunca executará ações.
- Comparar a interpretação principal, os resultados das ferramentas e o verificador. Divergência vira bloqueio seguro ou pergunta, nunca confirmação.
- Preservar contexto entre mensagens: respostas curtas como “sim”, “ele também”, “às 11” ou apenas um nome devem atualizar a solicitação correta, não criar ou apagar pedidos por conta própria.

### 4. Múltiplas pessoas
- Suportar pai/filho, casal, amigos, grupos, nomes informados em mensagens diferentes, mesmo ou outro serviço, mesmo ou outro horário.
- Exigir uma criação separada por pessoa e impedir que `services[]` represente pessoas diferentes.
- Não substituir o nome de dependente pelo titular da conversa; detectar conflitos de nomes completos, não apenas primeiro nome.
- Tratar telefone compartilhado explicitamente, sem assumir que todos os agendamentos pertencem à mesma pessoa.
- Antes de trocar/cancelar por `future_appointments_limit`, identificar qual pessoa possui o agendamento existente; se não for comprovável, perguntar e não cancelar.
- Vincular ownership de cancelamento/remarcação a pessoa + invoice + serviço + horário, não somente ao telefone.

### 5. Múltiplos serviços
- Distinguir combo real do catálogo, serviços separados na mesma pessoa e serviços de pessoas diferentes.
- Remover a contradição de `services[]`: sem combo real, cada serviço exige criação separada e horário validado; combo real mantém uma criação.
- Exigir evidência de que cada serviço foi realmente pedido; uma busca antiga ou menção incidental não cria pendência.
- Calcular sequência de horários pela duração real e validar cada slot com o profissional escolhido.

### 6. Reconciliação determinística de execução
- Criar uma identidade por item: pessoa + serviço + data + horário + profissional + ação.
- Contabilizar sucesso somente com resposta real e identificador da API; `sem error` não será suficiente.
- Distinguir `sucesso`, `falha definitiva`, `falha recuperável`, `resultado incerto` e `não executado`.
- Deduplicar por identidade e pelo identificador retornado, sem confundir dois agendamentos legítimos de pessoas diferentes.
- Em timeout após envio, consultar a agenda antes de repetir; nunca reenviar uma criação cujo resultado seja incerto.
- Corrigir o coringa de profissional: disponibilidade sem profissional não comprova vaga de um profissional explícito.

### 7. Guards isolados e árbitro de precedência
Cada guard será uma função sem efeitos colaterais que recebe o mesmo estado e devolve uma decisão estruturada com motivo e evidências. Um árbitro único aplica precedência explícita; guards não sobrescrevem diretamente a resposta um do outro.

Ordem de segurança proposta:
1. argumentos/ownership inválidos;
2. duplicidade ou resultado incerto;
3. remarcação órfã;
4. cancelamento falso ou falho;
5. criação parcial/múltipla;
6. confirmação fantasma;
7. confirmação desatualizada;
8. liberação da resposta.

- RescheduleGuard terá limite de uma criação válida por item e bloqueará ferramentas não relacionadas na recuperação.
- MultiBookingGuard reconciliará identidades, não apenas quantidades; nenhum classificador ou clamp poderá reduzir evidência estruturada.
- PhantomConfirmation e PhantomCancel bloquearão em produção após a matriz comprovar os caminhos legítimos.
- StaleConfirmation comparará a resposta com agenda consultada e com o item exato.
- CancelGuard validará sucesso real do cancelamento e preservará itens não selecionados da mesma comanda.
- Todo bloqueio devolverá motivo explícito à IA e ficará auditável.

### 8. Recuperação segura
- Recuperar somente itens pendentes identificados, nunca “tentar de novo” genericamente.
- Levar para a reinjeção pessoa, serviço, códigos, duração, data, horário, profissional e resultados anteriores.
- Se faltar nome ou outra decisão humana, perguntar e persistir a pendência.
- Se a API oferecer alternativas reais, apresentá-las sem inventar ou selecionar pelo cliente.
- Se o resultado for incerto, consultar antes de repetir.
- Após completar cada item, bloquear chamadas extras para ele.
- Nunca prometer continuação em segundo plano; escalar apenas quando a ferramenta de escalação realmente tiver sido executada.

### 9. Matriz ampla de situações
Cobrir combinações, não frases fixas:

- 1–4 pessoas; nomes juntos, separados, abreviados, iguais ou conflitantes.
- 1–4 serviços; iguais, diferentes, combo real, sem combo e menção incidental.
- Mesmo/diferentes horários, dias e profissionais; “qualquer profissional” seguido de escolha explícita.
- Pedido inicial completo, parcelado em várias mensagens, correção, desistência e mudança após confirmação.
- Confirmações curtas, negativas, condicionais, perguntas, ironia e resposta fora de contexto.
- Criação total, parcial, duplicada, API 401/403/404/422/429/5xx, timeout antes/depois do processamento e resposta malformada.
- Cadastro encontrado, nome divergente no mesmo telefone, dependente novo e falha no cadastro.
- Cancelamento único, múltiplo, comanda parcial, pessoa errada e invoice incorreto.
- Remarcação bem-sucedida, cancelamento sem nova criação, nova criação sem cancelamento e falha após cancelamento.
- Intervenção humana antes, durante e depois da automação; anti-eco e mensagens duplicadas do webhook.
- Confirmação de agendamento novo, preexistente, alterado, cancelado ou desatualizado.

Os testes usarão variações linguísticas geradas e casos reais anonimizados, mas as asserções verificarão estados e efeitos, não palavras específicas.

### 10. Testes e simulação
- Tornar testável o núcleo de decisão hoje preso no handler, com autorização deste plano para uma extração interna pequena e focada; não mover integrações nem alterar a arquitetura dos outros providers.
- Importar as funções reais nos testes, eliminando regexes copiadas que podem divergir da produção.
- Adicionar testes unitários por guard, testes de interação entre guards e cenários completos de múltiplos turnos.
- Fazer testes baseados em propriedades: nenhuma resposta confirma item sem sucesso correspondente; nenhum item concluído é repetido; nenhum cancelamento atinge item não selecionado; a ordem dos guards não muda o resultado final.
- Reprocessar conversas AppBarber recentes em modo simulação, sem chamadas de escrita, comparando decisão atual e nova.
- Executar regressões de Frizzar, Trinks, OneBeleza e Bemp para comprovar ausência de mudança comportamental.

### 11. Publicação controlada
- Primeiro executar o novo reconciliador em sombra e comparar decisões com produção.
- Publicar bloqueios em etapas após revisar divergências e falsos positivos.
- Publicar somente `whatsapp-webhook`, mantendo `verify_jwt = false`.
- Registrar intenção estruturada, resultados associados, decisões individuais, decisão final e motivo.

## Achados já confirmados que entrarão na correção
- Disponibilidade com `professional_code: 0` pode validar indevidamente um profissional explícito.
- RescheduleGuard pode executar mais de uma criação na mesma recuperação.
- Contagem AppBarber não deduplica identidade de agendamento.
- NameGuard pode confundir pessoas com mesmo primeiro nome.
- Cadastro, limite futuro e ownership tratam telefone compartilhado como uma única pessoa.
- `services[]` pode misturar pessoas e possui descrição contraditória.
- Timeout/retry de criação não possui confirmação idempotente suficiente.
- Testes atuais exercitam principalmente classificadores e regexes copiadas, não os guards reais.

## Critérios de aceite
- Toda alegação de criar, confirmar, cancelar ou remarcar possui resultado real associado ao item exato.
- Pedidos múltiplos não são reduzidos por janela, regex, classificador, filtro ou clamp.
- Sucesso parcial nunca produz confirmação total.
- Resultado incerto nunca é repetido antes de consulta.
- Uma pessoa não herda cadastro, agendamento ou cancelamento de outra apenas por compartilhar telefone.
- Cada guard é testável isoladamente e combinações de guards possuem resultado previsível.
- Nenhum guard apaga silenciosamente decisão de maior prioridade.
- Os demais providers permanecem comportamentalmente inalterados.
