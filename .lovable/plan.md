## Diagnóstico

Analisei `buildOneBelezaPromptSection` em `supabase/functions/whatsapp-webhook/index.ts` (linhas 4881–5031) e os logs recentes do tenant **BARBEARIA MARQUEZ Ceilândia** (`3c6ebda0…`).

O “pulo” não está no código de tools — todas as 8 ferramentas One Beleza continuam disponíveis e funcionando. O problema está **no próprio system prompt**, que foi otimizado para 3 passos e **instrui explicitamente a IA a NÃO oferecer barbeiros**:

- Passo 2 atual (linha 4954-4955):
  > "Se o cliente JÁ indicou preferência de barbeiro → ofereça os horários DAQUELE barbeiro.
  > Se o cliente disse 'qualquer um' ou não mencionou → **ofereça os horários do PRIMEIRO profissional retornado**."

Ou seja: quando o cliente não cita um barbeiro, a IA pula direto para horários de um único profissional escolhido por ela. Confirmado nos logs (`556191520056`): após o cliente pedir "Cabelo", a IA respondeu direto `"No Estúdio quem atende é o Nicollas. Hoje tenho 18h40, 18h50..."` — sem nunca listar os barbeiros disponíveis para o cliente escolher.

A camada de auto-correção (`resolveOneBelezaToolArgs`, `hydrateOneBelezaSessionStateFromProvider`) e a ferramenta `buscar_horarios_disponiveis` continuam retornando **todos** os profissionais — a IA só não está apresentando essa lista por instrução do prompt.

## Correção

Editar **somente** `buildOneBelezaPromptSection` em `supabase/functions/whatsapp-webhook/index.ts` para reintroduzir a etapa de seleção de barbeiro:

### Mudanças no prompt

1. Renomear o fluxo de "OTIMIZADO 3 PASSOS" para "4 PASSOS" e ajustar a tabela de parâmetros / cabeçalho.
2. Reescrever o **PASSO 2** para apenas obter disponibilidade (sem oferecer horários ainda):
   - Executa `buscar_horarios_disponiveis` com `date` + `servicoId`.
   - Resultado: lista de profissionais que têm vaga naquele dia.
3. Inserir um novo **PASSO 3 — ESCOLHA DO BARBEIRO** (obrigatório):
   - Se o cliente JÁ indicou preferência válida (nome bate com um dos retornados) → usa esse profissional, segue para o passo de horários.
   - Caso contrário → apresenta a lista de barbeiros disponíveis (ex.: "Pra esse dia temos o Nicollas, o João e o Pedro. Com qual prefere?") e **aguarda a resposta**. Proibido escolher pelo cliente.
   - Se o cliente disser "qualquer um / tanto faz" → aí sim escolhe o primeiro e informa ("Beleza, vou colocar com o Nicollas").
4. Mover a oferta de horários para o novo **PASSO 4 — HORÁRIOS** (usando os `horarios[]` do profissional escolhido).
5. Renumerar Confirmação → **PASSO 5** e Executar Agendamento → **PASSO 6**, mantendo as regras de validação e os parâmetros do `agendar` exatamente como estão hoje.
6. Atualizar a tabela "MAPA DE PARÂMETROS" e a tabela "FERRAMENTAS DISPONÍVEIS" para refletir a nova ordem (sem adicionar/remover ferramentas).
7. Adicionar regra explícita na seção 🚨 REGRAS ABSOLUTAS:
   > "❌ PROIBIDO oferecer horários antes que o cliente tenha escolhido (ou dispensado a escolha de) um barbeiro."

### O que NÃO muda

- Nenhuma alteração em ferramentas, tipos, banco, edge functions auxiliares, ID resolution layer, retry logic, alias logic, ou UI.
- `buscar_horarios_disponiveis` continua sendo a chamada única que traz profissionais + horários (eficiente, 1 round-trip).
- Provider Trinks e None ficam intocados.

### Arquivos afetados

- `supabase/functions/whatsapp-webhook/index.ts` — somente a função `buildOneBelezaPromptSection` (linhas ~4881–5031).

Após aprovar, aplico a edição e a edge function é redeployada automaticamente. Validamos na próxima conversa real do tenant Ceilândia (a IA deverá listar os barbeiros antes de oferecer horários).
