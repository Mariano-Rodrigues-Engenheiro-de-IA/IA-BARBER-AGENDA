## Contexto (Barbearia Marquez Ceilândia — One Beleza)

Investiguei os logs do telefone `5588921714278` (01:00–01:25 de 20/05) e o código atual de `whatsapp-webhook`. Achei as causas exatas das duas situações que você relatou. Tudo abaixo é específico para o provider **One Beleza** — não toca Trinks, Bemp, Frizzar nem none.

---

## Situação 1 — "telefone já associado a outra conta" em loop

### O que está acontecendo

O sistema de alias automático (`onebeleza_client_aliases`) já existe — então sua intuição de manter o cadastro automático já está implementada, mas ele tem 3 bugs concretos que travam o fluxo:

1. **Falso sucesso.** Na 1ª tentativa, a API One Beleza respondeu com HTTP 2xx mas corpo `"Erro ao realizar login com o cadastro"`. O código (`registerOneBelezaClient`) considerou `ok: true` porque olhou só o status, salvou o alias `95470000003` na tabela e seguiu. Mas a conta nunca foi de fato criada.
2. **Alias reutilizado eternamente.** A partir daí, todo retry chama `cadastrar_cliente` → real falha com "já associado" → tenta o **mesmo** alias `95470000003` → também falha com "já associado" (porque algum cadastro fantasma ficou amarrado a ele) → devolve `ok: false`. Nunca tenta gerar um próximo alias.
3. **`buscar_cliente` confirma o vazio mas o ciclo recomeça.** Em cada rodada `buscar_cliente` retorna "Nenhum cliente encontrado" (via alias), a IA reage chamando `cadastrar_cliente`, que volta a falhar igual — e a barbearia perde o agendamento.

### Minha recomendação (responde sua pergunta)

**Mantenha o mesmo número do cliente como tentativa principal, e o alias automático como fallback.** Pedir um telefone alternativo ao cliente cria fricção que faz a maioria desistir — o alias resolve sem o cliente nem perceber. O que precisa é corrigir os bugs.

### O que vou fazer

Em `supabase/functions/whatsapp-webhook/index.ts` (escopo restrito ao provider One Beleza):

- **Validar sucesso real, não só HTTP status.** Em `registerOneBelezaClient`, tratar como falha qualquer resposta cujo corpo contenha mensagens como "Erro ao realizar login", "erro ao cadastrar", "falha", ou cujo JSON não traga `codigo`/`clienteId`/`id`. Adicionar helper `isOneBelezaRegistrationSuccess(text)`.
- **Rotação de alias.** Quando o alias atual também devolver "telefone já associado" (ou falso-sucesso), marcar a linha em `onebeleza_client_aliases` como queimada (nova coluna `burned_at timestamptz`) e gerar o próximo alias automaticamente, até 5 tentativas dentro da mesma chamada. `resolveOneBelezaClientPhone` e `getOrCreateOneBelezaAlias` passam a ignorar aliases queimados.
- **Verificar antes de recadastrar.** Após gerar um novo alias e cadastrar com sucesso, fazer um `GetClientePeloNumero` com o alias para confirmar que existe de fato antes de retornar `ok: true`. Se não existir, queimar e seguir para o próximo.
- **Log + audit.** Cada queima e cada novo alias gera linha em `audit_logs` com `action: "onebeleza_alias_burned"` / `"onebeleza_alias_rotated"` para você acompanhar.

Resultado: a IA cadastra com sucesso de forma transparente mesmo que o telefone já esteja "preso" em outra conta global.

---

## Situação 2 — `agendar` sem `profissionalId`

### O que está acontecendo

O validador `buildOneBelezaSchedulingValidationResult` já bloqueia agendar sem `profissionalId` válido. O problema real é o **caminho** que a IA usa quando o cliente diz "qualquer barbeiro" ou quando ela pula etapas:

- `buscar_horarios` já retorna `profissionalId` em cada `disponibilidades[]` (você está certo — não precisaria nem chamar `buscar_barbeiros_por_servico`).
- Quando a IA escolhe um horário, hoje ela é obrigada a passar `profissionalId` explícito. Se esquecer, é bloqueada — mas o bloqueio não conserta automaticamente, devolve erro e a IA às vezes inventa um ID.

### O que vou fazer (só One Beleza)

1. **Auto-preenchimento de `profissionalId` a partir do slot.** Em `reconcileOneBelezaSchedulingArgs`, quando `profissionalId` estiver ausente mas existir **exatamente um** slot em `oneBelezaSlotOptions` que combine `servicoId` + `data` + `horarioInicio`, preencher `profissionalId` automaticamente com o do slot. Se houver mais de um (ex.: 2 barbeiros livres no mesmo horário), escolher o primeiro retornado por `buscar_horarios` (= "qualquer barbeiro"). Loga a correção em `tool_calls.correctionReason`.
2. **Hidratação forçada antes de agendar.** Se a IA chamar `agendar` sem ter chamado `buscar_horarios` na sessão, `hydrateOneBelezaSessionStateFromProvider` já existe — garantir que ele rode **antes** do validador e popule `oneBelezaProfessionalOptions` e `oneBelezaSlotOptions` a partir do endpoint consolidado.
3. **Regras explícitas no prompt base One Beleza** (`buildSystemPrompt` para provider onebeleza):
   - "Quando o cliente disser 'qualquer barbeiro', 'tanto faz' ou similar, escolha o primeiro `profissionalId` retornado por `buscar_horarios` para o horário escolhido. NUNCA agende sem `profissionalId`."
   - "Você NÃO precisa chamar `buscar_barbeiros_por_servico` se já tiver chamado `buscar_horarios` — os `profissionalId` já vêm nas disponibilidades. Use-os."
   - "É proibido inventar `profissionalId`. Use SEMPRE o ID exato retornado pela ferramenta na mesma interação."
4. **Mensagem de erro mais didática.** Quando ainda assim bloquear, devolver à IA a lista de `{profissionalId, profissionalNome, horarioInicio, horarioFim}` válidos, em vez do texto genérico, para ela auto-corrigir na próxima rodada.

---

## Escopo e impacto

- Apenas o provider **One Beleza** (`api_provider = 'onebeleza'`). Trinks, Bemp, Frizzar e none ficam intactos.
- Aplica-se automaticamente a todos os tenants atuais e futuros da One Beleza.
- Requer 1 migração: adicionar coluna `burned_at timestamptz` em `onebeleza_client_aliases`.

## Arquivos / mudanças

- `supabase/migrations/...` — adiciona `burned_at` em `onebeleza_client_aliases`.
- `supabase/functions/whatsapp-webhook/index.ts`:
  - `isOneBelezaRegistrationSuccess` (novo helper)
  - `registerOneBelezaClient` (rotação de alias + validação de sucesso real + verificação pós-cadastro)
  - `getOrCreateOneBelezaAlias` / `resolveOneBelezaClientPhone` (respeitar `burned_at`)
  - `reconcileOneBelezaSchedulingArgs` (auto-fill de `profissionalId` a partir do slot)
  - Bloco `agendar` em `executeOneBelezaTool` (garantir hidratação prévia)
  - `buildSystemPrompt` para One Beleza (3 regras novas)
  - `buildOneBelezaSchedulingValidationResult` (mensagem com lista de opções válidas)
