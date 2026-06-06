# Plano

## Objetivo
Criar uma proteção global para impedir que a IA execute a mesma ação mutável duas vezes em seguida na mesma conversa, mesmo quando o cliente manda mensagens separadas logo após a confirmação.

## Diagnóstico atual
Hoje o webhook já tem algumas proteções, mas elas não cobrem esse caso global:

- O estado persistente salva `executedToolNames`, porém isso só bloqueia por nome de ferramenta e exclui ferramentas de agenda/cancelamento/edição, que ficam livres para repetir.
- O estado também salva `scheduledSlotSignatures`, mas isso só protege agendamento idêntico de mesmo slot.
- Quando chega uma nova mensagem do cliente, a IA roda de novo com ferramentas liberadas e sem um “registro estruturado” das ações concluídas há poucos segundos.
- Resultado: mesmo com histórico textual, o modelo ainda pode tentar repetir uma ação já concluída.

## O que vou implementar

### 1) Ledger global de ações concluídas no estado da conversa
Adicionar ao `conversation_state` um histórico curto de ações mutáveis recentes, por exemplo:

```text
recentCompletedActions[]
- toolName
- category (booking, cancel, cadastro, custom_tool, etc.)
- dedupeKey normalizada
- status (success, blocked, failed)
- completedAt
- humanSummary
- resultIds principais
```

Isso fica no mesmo JSON de estado, então a mudança é global e sem depender de um provedor específico.

### 2) Chave de idempotência por intenção, não só por nome da ferramenta
Antes de executar qualquer ferramenta mutável, gerar uma `dedupeKey` normalizada.

Exemplos:
- agendamento: serviços + data + hora + profissional + cliente/telefone
- cancelamento: id do agendamento
- cadastro: telefone + nome validado
- ferramenta customizada: nome + payload essencial

Assim o bloqueio deixa de ser “essa ferramenta já rodou” e passa a ser “essa ação já foi concluída”.

### 3) Guarda global pré-execução
Criar uma barreira única antes de executar ferramentas mutáveis:

- Se já existe `success` recente para a mesma `dedupeKey`, bloquear a nova tentativa.
- Se a ação acabou de ser concluída e a nova mensagem do cliente não traz uma nova intenção clara, bloquear nova mutação e forçar resposta natural.
- Se a ação anterior falhou, não fingir sucesso; manter a regra de escalonamento humano.

Isso vira uma proteção global para agenda, cancelamento, cadastro e custom tools mutáveis.

### 4) Janela de “cooldown pós-sucesso”
Adicionar uma regra curta após qualquer mutação bem-sucedida.

Exemplo de comportamento:
- A IA acabou de agendar.
- O cliente manda logo depois “William” ou “obrigado”.
- Dentro dessa janela, a IA vê que existe uma ação recém-concluída e só pode:
  - responder naturalmente,
  - atualizar memória/resumo,
  - ou pedir complemento, se realmente faltar algo.
- Ela não pode repetir ferramenta mutável sem uma nova intenção explícita.

### 5) Injetar no contexto da IA um resumo estruturado do que acabou de acontecer
Além do histórico textual, incluir no prompt/contexto algo como:

```text
AÇÕES RECENTES CONCLUÍDAS:
- 16:26 agendar: concluído com sucesso para corte, dia X, hora Y, profissional Z
- Próxima mensagem do cliente só deve continuar a conversa; não repita essa ação sem novo pedido explícito
```

Isso ajuda o modelo a “raciocinar sobre o que acabou de fazer” antes mesmo do guard técnico bloquear.

### 6) Política global de repetição segura
Definir uma regra única:

- Ferramenta mutável só repete se houver mudança material de intenção ou parâmetros.
- Duas mensagens seguidas do cliente não significam duas execuções.
- Confirmação, nome, agradecimento, emoji, complemento solto ou resposta tardia não reabrem automaticamente a última ação.

### 7) Observabilidade e logs
Registrar quando o guard bloquear repetição:
- ferramenta
- dedupeKey
- ação anterior encontrada
- motivo do bloqueio
- trecho da última mensagem do cliente

Assim dá para auditar casos como Bendita Barber/William sem depender só do prompt.

## Arquivo principal
- `supabase/functions/whatsapp-webhook/index.ts`

## Validação
Vou validar com cenários como:
- cliente confirma agendamento e depois manda só o nome
- cliente manda duas mensagens seguidas com o mesmo pedido
- cliente agradece após sucesso
- cliente realmente quer uma segunda ação diferente
- ferramenta falha e a IA tenta repetir/confirmar

## Detalhes técnicos
- Reaproveitar o `conversation_state` existente; não devo precisar de nova tabela para a primeira versão.
- Manter os guards atuais específicos de agenda, mas colocar esse novo guard global acima deles.
- Salvar só um histórico curto de ações recentes para não inflar o estado.
- Diferenciar ferramentas mutáveis de consulta para não bloquear buscas legítimas.

## Resultado esperado
A IA para de “esquecer” a ação que acabou de concluir e deixa de tentar repetir ferramenta por causa de mensagens consecutivas do cliente. O bloqueio passa a ser sistêmico, não dependente de prompt nem restrito ao caso de agendamento.