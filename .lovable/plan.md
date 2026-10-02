# Corrigir falha na troca de alias do OneBeleza

## Problema confirmado
Quando o OneBeleza recusa o alias atual de um cliente e o sistema tenta gerar um novo, a troca **sempre falha**. Aí o cadastro é abandonado e o cliente não consegue agendar.

Causa: no banco, cada cliente só pode ter **uma linha de alias por barbearia**, contando também os aliases já descartados ("queimados"). Por isso, as 8 tentativas de gravar um alias novo batem nessa regra e falham. O código atual trata todo erro como "número repetido" e não registra o motivo real.

Esse é o sistema de alias que você pediu para não mexer sem a sua confirmação. Por isso a correção depende da sua aprovação.

## O que muda
1. **Banco:** a regra de "um alias por cliente" passa a valer só para o alias **ativo**. Os queimados ficam guardados como histórico e não bloqueiam mais um alias novo. A regra que impede dois clientes de usarem o mesmo alias continua igual.
2. **Código (`getOrCreateOneBelezaAlias`):**
   - registrar o código e a mensagem do erro em cada tentativa;
   - tentar o próximo número só quando o erro for de alias repetido;
   - em qualquer outro erro, parar na hora e mostrar o motivo real.
3. **Antes de criar um alias novo na troca:** marcar o alias ativo como queimado. Hoje isso já acontece em parte; vou conferir que sempre acontece antes da gravação.

## Detalhes técnicos
- Migration: `DROP CONSTRAINT onebeleza_client_aliases_tenant_id_real_phone_key` + `CREATE UNIQUE INDEX ... (tenant_id, real_phone) WHERE burned_at IS NULL`. O `idx_onebeleza_aliases_active` passa a ser esse índice único.
- Erro do Postgres: `error.code === "23505"` e mensagem com `alias_phone` → tenta o próximo número; qualquer outro erro → `throw` com o código e a mensagem.
- Deploy do `whatsapp-webhook`.

## Como comprovar
Num cliente de teste com alias ativo, forçar a troca (`forceNew = true`). O alias novo tem que ser criado, o antigo tem que ficar marcado como queimado, e o cadastro no OneBeleza tem que seguir em frente.
