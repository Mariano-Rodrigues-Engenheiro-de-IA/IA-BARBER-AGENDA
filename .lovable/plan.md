## Diagnóstico

Olhando o log real da última conversa (Mariano pedindo agendamento na Marquez Ceilândia):

```
buscar_servicos        → OK (filtro de unidade funcionou: 2 grupos, 26 serviços)
buscar_horarios_disponiveis(date=2026-04-30, servicoId=2902 "Consultoria de Visagismo R$500") → []
IA: "Putz, amanhã não tem vaga. Quer ver outro dia?"
```

A IA pulou direto de `buscar_servicos` para `buscar_horarios_disponiveis` (fluxo de 3 passos, está correto), mas a resposta `[]` da One Beleza é **ambígua**:
- pode ser "nenhum profissional habilitado pra esse servicoId"
- ou "todos profissionais lotados nesse dia"
- ou "data inválida / no passado"

Como `[]` é tratado como "sem vaga", a IA encerrou sem investigar. E o serviço escolhido (Consultoria de Visagismo R$500) tem altíssima chance de ter só 1 profissional (Nicolas) — então qualquer dia que ele não trabalhe devolve `[]` e o cliente pensa que a barbearia inteira fechou.

## Objetivo

Garantir que o fluxo enxuto (cliente → serviço → unidade → horários) **nunca devolva `[]` sem explicação** e que o `servicoId` enviado pra API seja sempre o da unidade correta confirmada com o cliente.

## Mudanças propostas

### 1. Enriquecer `buscar_horarios_disponiveis` com diagnóstico server-side

Em `supabase/functions/whatsapp-webhook/index.ts` no case `buscar_horarios_disponiveis` (~L4982):

Quando `parsed` for `[]` ou todos os `disponibilidades[]` estiverem vazios, **não retornar array vazio**. Em vez disso, fazer uma chamada paralela a `PesquisarProfissionais?servicosId=X` pra descobrir o motivo:

```text
- Se 0 profissionais habilitados pro serviço:
    return { vazio: true, motivo: "servico_sem_profissional",
             mensagem: "Esse serviço não tem profissional habilitado nesta unidade." }
- Se há N profissionais mas 0 horários no dia:
    return { vazio: true, motivo: "dia_sem_vaga",
             profissionais_habilitados: [...nomes],
             sugestao: "Tente outro dia ou outro profissional." }
- Se a data é no passado / hoje sem horários restantes:
    return { vazio: true, motivo: "data_invalida_ou_passada", ... }
```

A IA recebe contexto rico em vez de `[]`, e o prompt instrui ela a **oferecer alternativa concreta** (outro dia, outro serviço equivalente da mesma unidade, ou escalar humano).

### 2. Adicionar `unidade` resolvida ao `sessionState` e validar no resolver

Hoje `allowedServiceIds` mistura IDs de Barbearia (566) + Estúdio (567). Vamos adicionar `selectedUnit: 566 | 567 | null` que é gravado quando:
- a IA confirma a unidade com o cliente, OU
- o `servicoId` escolhido pertence inequivocamente a um grupo (ex: 2902 → 567).

Em `resolveOneBelezaToolArgs` (~L1344), adicionar guard: se `selectedUnit` está setado e o `servicoId` enviado pertence ao OUTRO grupo, **bloquear**:

```json
{ "error": "servicoId X é da unidade Y, mas o cliente confirmou Z. Confirme com o cliente antes de prosseguir.", "blocked": true }
```

Isso fecha a brecha de a IA "trocar de unidade no meio do agendamento" sem perceber.

### 3. Ajustes no `agent_system_prompt` da Marquez Ceilândia

Migration SQL adicionando duas instruções enxutas:

```text
## 🚨 INTERPRETANDO RESPOSTAS DE buscar_horarios_disponiveis

Quando a resposta vier com {vazio: true, motivo: ...}, NÃO diga genericamente
"não tem vaga". Use o motivo:

- "servico_sem_profissional" → "Esse serviço específico não está disponível
   na [unidade]. Posso te oferecer [serviço equivalente] ou escalar pro
   atendente humano."
- "dia_sem_vaga" → "Nesse dia [profissionais habilitados] estão sem horário.
   Quer ver outro dia?"
- "data_invalida_ou_passada" → peça outra data.

## 🔁 SEMPRE OFEREÇA UMA ALTERNATIVA antes de encerrar

Nunca diga só "não tem vaga". Sempre proponha: outro dia, outro profissional,
serviço similar da mesma unidade, ou escalar humano.
```

### 4. Logging adicional pra diagnóstico futuro

No case `buscar_horarios_disponiveis`, quando devolver `vazio: true`, logar:
```
[OneBeleza][diag] empty result servicoId=X date=Y reason=... profCount=N
```

## Arquivos afetados

- `supabase/functions/whatsapp-webhook/index.ts`
  - case `buscar_horarios_disponiveis` (~L4982): enriquecer resposta vazia.
  - tracking de tools (~L2488 e ~L2527): popular `sessionState.selectedUnit` quando inferível.
  - `resolveOneBelezaToolArgs` (~L1344): guard de troca de unidade.
- 1 migration SQL atualizando `agent_system_prompt` da Marquez Ceilândia (`3c6ebda0-...`) com as duas seções acima.

## Sem mudanças

- Schema do banco, RLS, tabelas novas, frontend, tools expostas à IA (continua sendo o trio mínimo: `buscar_servicos`, `buscar_horarios_disponiveis`, `agendar`).
- Marquez Asa Sul (`9e4d5866-...`) continua inativo conforme combinado.

## Validação pós-deploy

1. `❌` no WhatsApp pra resetar estado.
2. Pedir "consultoria de visagismo amanhã" → deve responder com motivo específico (`servico_sem_profissional` ou `dia_sem_vaga` + nome do profissional habilitado).
3. Pedir "corte amanhã" sem dizer unidade → IA deve perguntar Barbearia ou Estúdio antes de chamar horários.
4. Forçar troca de unidade no meio (cliente diz Estúdio, depois pede serviço da Barbearia) → resolver bloqueia e IA reconfirma.
5. Conferir log `[OneBeleza][diag] empty result ...` quando vier `[]`.

## Risco

Baixo. As mudanças são aditivas:
- Resposta enriquecida ainda é JSON consumível pela IA.
- Guard de unidade só dispara quando `selectedUnit` está setado (caso contrário, comportamento atual).
- Outros tenants One Beleza sem `onebeleza_unit_filter` não são afetados.
