# Fix: cadastro One Beleza quando número já está em outra conta

## Problema (confirmado nos logs)

Na Barbearia Marquês Ceilândia (`556184897699`):

1. `buscar_cliente` com o telefone real → retorna vazio (cliente não existe nesta unidade)
2. `cadastrar_cliente` com mesmo telefone → API responde:
   > "O número de telefone já está associado a outra conta de usuário. Por favor, insira um número de telefone diferente."
3. `agendar` → bloqueado por "Cliente não encontrado pelo telefone"

A IA fica em loop, tentando o mesmo número várias vezes (5 tentativas no log), sem nunca conseguir agendar.

**Causa raiz:** a base da One Beleza é global — o telefone do cliente já está cadastrado sob outro estabelecimento/usuário, então tanto a busca quanto o cadastro falham neste tenant.

## Solução: telefone-alias por tenant (persistente)

Ao detectar o erro de telefone duplicado, geramos um **telefone-alias único por tenant** (ex.: `61900000001`, `61900000002`, ...), cadastramos com esse alias + nome real do cliente, e guardamos o mapeamento `(tenant_id, real_phone) → alias_phone` em uma nova tabela. Daí em diante, qualquer chamada da One Beleza para esse cliente usa o alias automaticamente.

### Por que não usar só placeholder no momento?

Porque o endpoint `agendar` usa `?celular={tel}` para **atribuir o agendamento ao cliente** e também para resolver o `cliforcolsid`. Se cadastrarmos com alias mas voltarmos a buscar com o telefone real, a busca continua falhando. O alias precisa ser **lembrado e reutilizado** em todas as chamadas seguintes (busca + agendamento + busca de agendamentos do dia).

## Mudanças

### 1. Nova tabela `onebeleza_client_aliases`

```text
tenant_id      uuid       (FK indireta para tenants)
real_phone     text       (telefone real do WhatsApp, só dígitos, sem 55)
alias_phone    text       (telefone-alias usado na One Beleza)
real_name      text       (nome real informado pelo cliente)
created_at     timestamptz
UNIQUE (tenant_id, real_phone)
UNIQUE (tenant_id, alias_phone)
```

RLS: admins veem tudo, clients veem só do seu tenant, service insere/lê.

### 2. Função `getOrCreateOneBelezaAlias(tenant_id, real_phone)`

- Gera prefixo por tenant a partir do hash do `tenant.id` (3–4 dígitos estáveis), evitando colisão entre tenants.
- Sequência: pega o maior `alias_phone` existente para esse tenant e incrementa (ex.: `619000000001` → `619000000002`).
- Formato final: 11 dígitos brasileiros válidos para a API aceitar.

### 3. Lógica em `registerOneBelezaClient`

Fluxo atualizado:

```text
1. Tenta cadastro com telefone REAL + nome real
2. Se 2xx → ok, retorna
3. Se erro de "email em uso/obrigatório" → retry com email gerado (já existe)
4. NOVO: se erro de "número já associado a outra conta" →
   a. Gera/recupera alias para (tenant_id, real_phone)
   b. Faz cadastro com alias_phone + nome real
   c. Persiste mapping na tabela
   d. Retorna { ok: true, aliasUsed: alias_phone, realPhone: real_phone }
5. Se ainda falhar → retorna erro original
```

### 4. Resolver alias antes de chamadas da One Beleza

Criar helper `resolveOneBelezaClientPhone(tenant_id, real_phone)` que retorna o alias se existir, senão o telefone real. Aplicar em:

- `buscar_cliente` (case do `executeOneBelezaTool`)
- `agendar` (linha ~5903 — `clienteTel`)
- `buscar_agendamentos_dia`
- `confirmar_agendamento` / `desmarcar_agendamento`

Assim, mesmo em conversas futuras, o sistema lembra que aquele WhatsApp usa o alias X na One Beleza.

### 5. Ordem de busca melhorada (bônus)

Em `buscar_cliente`, antes de retornar "não encontrado":
- Tentar com `55` + telefone, sem `55`, com/sem o `9` adicional (variações comuns BR), para reduzir falsos negativos.

### 6. Prompt da IA

Atualizar a seção One Beleza do system prompt para deixar explícito:
- Se `cadastrar_cliente` retornar `{ ok: true, aliasUsed: ... }`, **prossiga normalmente com agendar** — o sistema cuida do mapeamento.
- Não tentar repetir o cadastro com variações do telefone.

### 7. Observabilidade

- Log `[OneBeleza][alias] tenant=… real=… alias=… reason=phone_already_in_use`
- Insert em `audit_logs` (entity=`onebeleza_alias`, action=`created`) para o ADM ver no painel de Auditoria.

## Arquivos afetados

- `supabase/migrations/<new>.sql` — tabela + RLS
- `supabase/functions/whatsapp-webhook/index.ts`
  - `registerOneBelezaClient` (linhas ~103–143): detectar duplicata + alias fallback
  - `executeOneBelezaTool` cases `buscar_cliente`, `cadastrar_cliente`, `agendar`, `buscar_agendamentos_dia`, `confirmar_agendamento`, `desmarcar_agendamento`
  - `buildSystemPromptOneBeleza`: instruir IA sobre o fluxo de alias

## Alternativas consideradas

- **Só placeholder sem mapping persistente** (sua sugestão original): mais simples, mas o `agendar` voltaria a quebrar pois ele busca cliforcolsid pelo telefone — precisaria também guardar o telefone usado. Por isso optei pela tabela.
- **Pedir ao cliente outro telefone**: péssima UX e o cliente provavelmente não tem outro.
- **Detectar e extrair clienteId da mensagem de erro**: a API não devolve o id no erro, só a mensagem genérica — inviável.

Após aprovação, implemento migration + alterações no webhook e testo no log do tenant Marquês Ceilândia.
