## Contexto

Comparando os dois prompts:

- **Bendita Barber** (validado, Trinks): tem ~1229 linhas com fluxo conversacional detalhado, regras de erro, edge cases (múltiplos serviços, dois agendamentos, atrasos, etc.).
- **Marquez Ceilândia** (em validação, One Beleza): tem só ~138 linhas. Possui identidade, tom de voz, regras de visagismo, atrasos, descontos, elogios — mas **NÃO tem fluxo de agendamento conversacional** nem regras de filtro por unidade.

**Importante**: o fluxo técnico One Beleza (sequência de tools, parâmetros, IDs) JÁ é injetado automaticamente no system prompt pela função `buildOneBelezaPromptSection` no webhook (linhas 3845-3993). Então o que falta no `agent_system_prompt` do tenant não é o fluxo técnico — é o **fluxo conversacional de negócio** (como conduzir a conversa, em que ordem perguntar serviço/barbeiro/dia, como apresentar opções), além de regras de filtragem por unidade.

**Problema do token One Beleza**: o token atual da Marquez retorna serviços de 3 unidades (Barbearia Ceilândia, Estúdio Ceilândia, Estúdio Asa Sul). A IA fica perdida quando vê "Corte com técnica de visagismo" em mais de uma unidade. Como a unidade ativa é só **Barbearia Marquez Ceilândia Norte**, precisamos filtrar os serviços antes de entregar pra IA.

## O que vou fazer

### 1. Adicionar filtro de unidade no `buscar_servicos` (server-side)

Em `supabase/functions/whatsapp-webhook/index.ts`, no case `buscar_servicos`:
- Ler um novo campo `tenant.agent_settings.onebeleza_unit_filter` (string ou array de strings) com nomes/keywords de grupos permitidos (ex: `["Barbearia Marquêz", "Ceilândia"]`).
- Após receber resposta da API, filtrar o array retornado mantendo apenas grupos cujo nome contenha alguma das keywords (case-insensitive).
- Se filtro vazio ou ausente, manter comportamento atual (retorna tudo).
- Logar quantos grupos foram filtrados pra debug.

Aplicar mesmo filtro em `buscar_barbeiros_por_servico` se necessário (provavelmente não — barbeiros já vêm filtrados por servicosId).

### 2. Configurar `onebeleza_unit_filter` no tenant Marquez Ceilândia

Migration via SQL:
```
UPDATE tenants
SET agent_settings = jsonb_set(
  COALESCE(agent_settings, '{}'::jsonb),
  '{onebeleza_unit_filter}',
  '["Barbearia Marquez", "Barbearia Marquêz"]'::jsonb
)
WHERE id = '3c6ebda0-f193-439a-b023-ed7135dc2d83';
```

(Vou primeiro chamar `buscar_servicos` real pra ver os nomes exatos dos grupos retornados pela API e ajustar o filtro com precisão antes de aplicar.)

### 3. Reescrever o `agent_system_prompt` da Marquez Ceilândia

Manter tudo que já está bom (identidade, tom, visagismo, atrasos, descontos, elogios, infantil) e **adicionar** as seguintes seções, espelhando o estilo validado da Bendita:

- **🔷 FLUXO DE AGENDAMENTO (conversacional)** — como conduzir a conversa: 
  - Etapa 1: identificar serviço (corte tradicional / corte com visagismo)
  - Etapa 2: perguntar preferência de barbeiro
  - Etapa 3: perguntar dia
  - Etapa 4: oferecer horários
  - Etapa 5: confirmar e executar
  - Pular etapas quando o cliente já forneceu a informação na mensagem inicial
- **🔷 REGRA DE UNIDADE — APENAS BARBEARIA CEILÂNDIA**
  - "Você atende EXCLUSIVAMENTE na Barbearia Marquez Ceilândia Norte."
  - "Os serviços retornados pelo sistema podem incluir nomes parecidos de outras unidades. SEMPRE escolha o serviço da Barbearia Ceilândia."
  - "Se o cliente perguntar sobre Asa Sul ou outra unidade → ESCALAR_HUMANO."
- **🔷 REGRAS DE ERRO E REJEIÇÕES** (estilo Bendita): nunca confirmar agendamento sem retorno de sucesso, nunca inventar horário, nunca listar horários sem ter serviço definido.
- **🔷 MÚLTIPLOS SERVIÇOS NA MESMA VISITA** (ex: corte + barba) — adaptado pra One Beleza.
- **🔷 REAGENDAMENTO E CANCELAMENTO** — espelho do que existe pra Bendita, adaptado.

A migration vai aplicar via `UPDATE tenants SET agent_system_prompt = '...' WHERE id = '3c6ebda0-...'`.

### 4. Validação

- Confirmar que o fluxo técnico injetado por `buildOneBelezaPromptSection` continua funcionando junto com o novo prompt customizado (não há conflito — o customizado vem antes e o técnico depois, ambos coexistem).
- Pedir pro usuário fazer um teste real no WhatsApp depois de aplicado.

## Detalhes técnicos

**Arquivos afetados**:
- `supabase/functions/whatsapp-webhook/index.ts` (case `buscar_servicos`, ~10 linhas adicionadas)
- 1 migration SQL (UPDATE em `tenants` para id `3c6ebda0-f193-439a-b023-ed7135dc2d83`)

**Sem mudanças**: schema, RLS, novas tabelas, frontend.

**Risco**: baixo — filtro só ativa se `onebeleza_unit_filter` estiver setado. Outros tenants One Beleza não são afetados.

## Pergunta antes de executar

Antes de aplicar o filtro de unidade, eu preciso ver a resposta real do `buscar_servicos` da Marquez pra saber o nome exato dos grupos (ex: "Barbearia Marquez Ceilândia" vs "Estúdio Visagismo Ceilândia" vs "Estúdio Asa Sul"). Quer que eu:

- **(a)** Faça uma chamada real à API One Beleza com o token da Marquez agora pra inspecionar os nomes dos grupos antes de definir o filtro, OU
- **(b)** Você me passa os nomes exatos dos grupos que aparecem no app One Beleza, OU
- **(c)** Eu uso um filtro genérico baseado em "Barbearia" + "Ceilândia" (excluindo "Estúdio" e "Asa Sul") e ajustamos depois se necessário.