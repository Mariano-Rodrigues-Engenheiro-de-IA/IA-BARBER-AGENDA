# Parte C — correção do Monitor 24h

## Resultado da investigação

A investigação A1–A7 e o diagnóstico B foram apresentados antes deste plano. Nenhuma alteração de produção foi feita.

Confirmado: 77 erros de crédito no dia de Brasília; erros excluídos das próximas seleções; confirmações e guards pulados; referência temporal incompleta; descartados sem conteúdo persistido; ausência de alerta ativo. O histórico comprova troca de versão de Gemini para OpenAI, não fallback automático.

## 1. Integração direta e falhas visíveis

- Migrar somente o auditor para OpenAI direta, usando o segredo `OPENAI_API_KEY` já utilizado pelo atendente, sem expor seu valor ou presumir quem paga essa conta.
- Reutilizar o padrão de integração existente; fixar um modelo OpenAI sem fallback entre modelos/providers. Não mudar o atendente nem criar módulo compartilhado/refatoração estrutural.
- Preservar saída estruturada e leitura incremental. Exigir conclusão válida: resposta vazia, stream interrompido e schema inválido são erros, nunca auditoria limpa.
- Registrar endpoint, modelo solicitado e retornado, duração, status HTTP, uso de tokens e identificador de requisição. Traces sem cabeçalhos de autenticação, com acesso restrito e dados pessoais minimizados.
- Repetir apenas falhas transitórias, com espera crescente, respeito a Retry-After e limite de tentativas. Crédito/configuração bloqueiam a cadeia; retomada explícita ou verificação controlada, não insistência por turno.

## 2. Saúde, fila e persistência confiável

- Três execuções consecutivas com falha geram incidente e aviso ao dono, uma vez por incidente; recuperação gera aviso de normalização.
- Separar falha do serviço de falha isolada de um dossiê. Exibir última execução, último sucesso, fila pendente, idade do item mais antigo e motivo do bloqueio.
- Detectar também cron sem executar: um processo parado não produz três erros.
- Usar `ai_audit_runs` como controle de reprocessamento, com tentativas, próxima tentativa e reserva temporária de trabalho. Sem tabela nova de fila.
- Selecionar pendências antigas sem depender da janela dos últimos turnos. Impedir que execuções simultâneas auditem e cobrem o mesmo item.
- Não marcar auditado se a gravação dos achados falhar. Reprocessamento idempotente, preservando revisão humana e histórico das tentativas.
- Reprocessar os 77 erros identificados por IDs e período original; não apagar seus erros históricos.

## 3. Regras baratas em todos os turnos e seleção por risco

- Avaliar todos os turnos das empresas habilitadas com regras em código, sem chamada ao modelo. Mostrar separadamente cobertura global e cobertura das empresas habilitadas.
- R1: `silent_mode:true` com resposta não vazia registra violação da saída gerada; conferir rastros de envio para distinguir mensagem gerada, bloqueada e efetivamente enviada. Não chamar o modelo apenas para provar esse fato.
- R2: afirmação de execução sem sucesso correspondente vira risco prioritário. Antes de concluir erro, conferir reservas existentes, histórico e semântica da ferramenta. “Está confirmado” e “prontinho” não provam nova escrita isoladamente.
- Reconhecer sucesso por contrato do provider: edição com `success:true` não exige criação de novo ID nem cancelamento prévio.
- R3: guard com `acao` iniciada por `detected_` nunca recebe `skipped_no_tools`; é sinal para análise, não prova automática de que o cliente foi prejudicado.
- Chamar o modelo para afirmações/guards ainda não resolvidos pelas provas determinísticas e divergências suspeitas de agenda. Saudações, agradecimentos, despedidas e consultas claramente coerentes continuam sem LLM.
- Para turnos sem ferramenta, usar inventário estruturado de chamadas e resultado da checagem como prova de ausência, sem inventar citação de uma API que não foi chamada.

## 4. Datas e qualidade da evidência

- Construir data/hora de Brasília, hoje/amanhã/ontem e calendário de 14 dias a partir da data do turno, nunca da execução da auditoria.
- Reconhecer ISO com e sem hora, formato brasileiro e offsets explícitos. Manter horário local sem conversão dupla.
- Comparar data + hora + profissional + serviço no mesmo registro; retirar a absolvição baseada em um horário/dia encontrado em qualquer lugar do dossiê.
- Preservar dados relevantes de listas longas mediante seleção estruturada, sem cortar cegamente após 1.400 caracteres. Ausência em dados incompletos não prova inexistência.
- Atualizar o prompt padrão e o override ativo: linguagem relativa é válida; 13h não equivale a 13h10; PUT bem-sucedido é remarcação; histórico não prova falha do turno atual.
- Alinhar categorias do prompt/schema/painel, inclusive a divergência existente em `duplicidade_agendamento`.

## 5. Descartes e categorias

- Acrescentar aos registros existentes o conteúdo de cada candidato descartado e um motivo enumerado: prova ausente, dado insuficiente, equivalência temporal, duplicado, contradição etc.
- Tornar descartes consultáveis no detalhe da execução, separados dos achados procedentes; manter controle de acesso equivalente ao monitor.
- Adicionar as categorias pedidas: `violacao_silent_mode`, `acao_afirmada_nao_executada`, `profissional_inventado`. A última exige catálogo/contexto suficiente e tratamento de apelidos; nome ausente de trecho truncado não é prova.
- Não criar provider, ferramenta ou tabela nova. Se uma tabela nova se mostrar indispensável, confirmar nome e escopo antes.

## 6. Correção do atendente: aprovação separada

A detecção pelo monitor não impede mensagens futuras. Proponho um ajuste pontual na barreira final de envio para respeitar transferência silenciosa, com motivo registrado. Esse ajuste no `whatsapp-webhook` depende de aprovação explícita; não inclui refatoração, alterações no ledger, alias OneBeleza ou fallback de confirmação. Testar especificamente precedência entre reserva criada e transferência silenciosa antes de qualquer mudança nesse fluxo.

## Volume e orçamento

Medição no banco para 14/09 em Brasília até o recorte consultado:

- 511 turnos totais; 270 de empresas atualmente habilitadas.
- 31 auditorias bem-sucedidas, comparáveis às 30 do levantamento anterior; isso não é o número total de tentativas nem de chamadas faturadas.
- Triagem textual exploratória: 55 turnos com palavras de confirmação/execução ou guard detectado; 51 após separar os casos sobrepostos com silent_mode e resposta.
- 53 turnos com silent_mode e resposta entre 54 escalações silenciosas, contra 52/53 no recorte anterior.

**Referência inicial: cerca de 51 candidatos nesse recorte, não 511 chamadas.** Não é uma previsão fechada de LLM: consultas a histórico podem eliminar candidatos, enquanto outras divergências de agenda podem acrescentá-los. A contagem exploratória não é detector de intenção validado.

Antes de ativar, rodar a seleção final sem LLM sobre o mesmo conjunto congelado e informar o número exato de candidatos e exclusões por motivo. Medir tokens em amostra aprovada e calcular custo diário com preços vigentes, separado do custo único do reprocessamento. Sem teto monetário informado, não afirmar que cabe no orçamento.

Impor limite diário de chamadas/tokens/custo e tamanho de lote. Ao atingir o teto, manter pendências e avisar, nunca descartá-las. O limite definitivo e o canal/destinatário externo do alerta precisam ser confirmados antes da ativação; o painel terá aviso persistente em qualquer caso.

## Validação e critérios de aceite

1. Reexecutar em modo de validação os seis casos temporais: nenhum falso achado novo. Acrescentar controles negativos com data realmente errada, profissional errado no mesmo horário, virada de dia/mês e auditoria tardia.
2. `555ef6cb` e todos os guards `detected_*` passam pela auditoria, nunca pelo skip; isso não obriga condenar o turno sem contexto.
3. R1 detecta todos os 52 casos do recorte original e os adicionais confirmados, distinguindo entrega de texto gerado.
4. Testar confirmação de reserva existente, edição Trinks com success:true, consulta truncada e transferência silenciosa.
5. Simular três falhas, pausa, notificação única, recuperação e reprocessamento sem duplicar achados/cobranças. Testar falha de persistência e concorrência.
6. Fazer chamada real com a integração nova e conferir resposta, endpoint e modelo efetivo. Novas chamadas de modelo sem prefixo de gateway; execuções só de regra identificadas separadamente, sem modelo fictício.
7. Não apagar históricos de `ai_gateway`/`credit_limit_reached`: ausência desses erros vale para novas execuções após a migração. OpenAI direta ainda pode sofrer quota/indisponibilidade própria.
8. Erros abaixo de 1% são meta operacional a verificar em um dia completo após ativação, não garantia antecipada sobre serviço externo.
9. Descartes consultáveis com motivo, consumo real dentro do teto aprovado e relatório do custo do reprocessamento.

## Implantação

Aprovar escopo, orçamento e destino do alerta; implementar e testar sem tocar revisões históricas; validar chamadas reais em lote pequeno; implantar o auditor; liberar reprocessamento limitado; acompanhar um dia completo. Publicar o atendente somente se seu ajuste separado for aprovado e testado.
