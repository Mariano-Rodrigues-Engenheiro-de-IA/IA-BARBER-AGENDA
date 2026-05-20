## Contexto — o que está acontecendo

Consultei os últimos cadastros (`onebeleza_client_aliases`) e confirmei o que você viu na agenda:

| Data | Nome salvo | Telefone |
|---|---|---|
| 20/05 01:02 | "Aumenta no valor acima de se incluir a barba né Isso" | 5588921714278 |
| 19/05 13:11 | "Richard Mateus Bento de Sousa" ✅ | 6182032806 |
| 19/05 12:35 | "tem no sabado as h Guilherme de Melo" | 6181456255 |

Dois de três cadastros pegaram a **transcrição inteira do áudio do cliente** como se fosse o nome. Confere exatamente sua suspeita.

### Por que está acontecendo

No `whatsapp-webhook/index.ts`:

1. `extractExplicitClientName` (linha 65) aceita **a mensagem inteira** como nome sempre que a IA tiver perguntado "qual é seu nome" em **qualquer** turno recente. Não valida se o texto parece um nome (frase com verbo, muitas palavras, etc.).
2. `isUsableClientName` (linha 45) só rejeita se tiver dígito ou estiver numa lista pequena de saudações. "Aumenta no valor acima de se incluir a barba né Isso" passa porque só tem letras e espaços.
3. `sanitizeClientName` remove pontuação e acentos mas mantém a frase toda — vira o `nome` salvo.
4. O prompt instrui a IA a pedir **"nome completo"** (você quer só nome e sobrenome).
5. Quando o áudio vem como transcrição longa, a IA chama `cadastrar_cliente` na sequência usando essa transcrição.

## Escopo

Apenas provider **One Beleza** (Trinks, Bemp, Frizzar, none intactos). Aplica para todos os tenants atuais e futuros.

## Mudanças (em `supabase/functions/whatsapp-webhook/index.ts`)

### 1. Validador de nome muito mais rigoroso (`isUsableClientName` + novo `looksLikeRealName`)

Um texto só é aceito como nome se passar em TODOS:
- 2 a 4 palavras (nome + sobrenome, no máximo 4 partes).
- Cada palavra com 2+ letras, só letras (acentos OK), sem dígitos.
- Comprimento total entre 4 e 60 chars.
- Não contém verbos/palavras típicas de fala ("quero", "tem", "incluir", "agendar", "marcar", "barba", "corte", "horario", "valor", "sabado", "domingo", dias da semana, "preço", "quanto", "manhã", "tarde", "noite", "agora", "depois", "antes", lista de ~40 stopwords).
- Não contém "né", "tipo", "tá", "uhum", "aham" (marcadores de fala).
- Cada palavra começa com letra maiúscula OU é convertível (vamos title-case automaticamente se passar nos outros critérios).

### 2. Extração mais conservadora (`extractExplicitClientName`)

- Só aceita a mensagem inteira como candidato a nome quando:
  - A **última** mensagem do assistente (não qualquer mensagem passada) pediu nome, OU
  - A mensagem tem o padrão explícito "meu nome é …" / "me chamo …" / "sou o/a …".
- Sempre extrai só os tokens à direita do conector e roda `looksLikeRealName`.
- Se falhar, retorna `null` → não popula `explicitClientName`.

### 3. Re-validação no momento do `cadastrar_cliente` (bloco em `~3040`)

- Antes de chamar a API, roda `looksLikeRealName(forcedName)` mesmo já estando em `sessionState.explicitClientName`. Se falhar (caso o nome tenha sido populado por engano em turno anterior), zera e devolve à IA o bloqueio "NOME_NAO_COLETADO" com instrução: "Pergunte de novo: 'Qual seu nome e sobrenome?' Aguarde texto claro com 2 a 4 palavras, só letras."
- Adiciona linha em `audit_logs` com `action: "onebeleza_name_rejected"` e `before: { raw, reason }` para você acompanhar.

### 4. Prompt — pedir "nome e sobrenome" (não "nome completo")

Em `buildSystemPrompt` para provider `onebeleza`, e na mensagem de bloqueio (linha 3060), trocar todas as ocorrências:
- "Qual é o seu nome completo?" → "Qual seu nome e sobrenome?"
- Adicionar regra: "Peça SOMENTE nome e sobrenome (2 palavras). Não peça nome completo, não peça CPF, não peça e-mail."
- Adicionar regra: "Se a resposta do cliente parecer uma frase (mais de 4 palavras, contém verbos, fala sobre horário/serviço/preço), NÃO use como nome. Responda algo como 'Desculpe, não peguei seu nome. Pode me dizer só o nome e sobrenome?' e aguarde."
- Adicionar regra: "Se a mensagem do cliente foi um áudio transcrito, tenha dobro de cuidado: confirme antes de cadastrar quando o texto parecer fala solta."

### 5. Fluxo de cadastro mais redondo (prompt + estado)

Reforçar no prompt One Beleza a sequência fixa:
1. `buscar_cliente` por telefone — SEMPRE primeira ação quando o cliente quer agendar.
2. Se existir → seguir para `buscar_servicos`. NUNCA chame `cadastrar_cliente`.
3. Se não existir → pergunte "Qual seu nome e sobrenome?" e AGUARDE.
4. Quando o cliente responder com algo que pareça nome (validador passa) → `cadastrar_cliente`.
5. Se a resposta não parecer nome → re-pergunte uma vez. Após 2 tentativas falhas, escale para humano (se a tool existir) ou prossiga assumindo "Cliente WhatsApp" só como último recurso (continua bloqueado pelo validador — vai forçar a IA a insistir).

## Arquivos

- `supabase/functions/whatsapp-webhook/index.ts` — alterações em `sanitizeClientName`, `isUsableClientName`, novo `looksLikeRealName`, `extractExplicitClientName`, bloco `cadastrar_cliente` em `executeOneBelezaTool` / dispatcher (linha ~3040), e `buildSystemPrompt` para One Beleza.

Sem migrações, sem novos secrets.

## Resultado esperado

- "Aumenta no valor acima de se incluir a barba né Isso" → rejeitado, IA re-pergunta.
- "tem no sabado as h Guilherme de Melo" → rejeitado (tem "tem", "sabado", muitas palavras), IA re-pergunta.
- "Guilherme de Melo" → aceito.
- "Richard Mateus" → aceito.
- "Meu nome é João Silva" → extrai "João Silva", aceito.
- "João" sozinho → rejeitado (precisa sobrenome), IA pede sobrenome.