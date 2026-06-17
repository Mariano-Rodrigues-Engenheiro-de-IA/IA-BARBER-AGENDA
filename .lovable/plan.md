# Corrigir flash de "acesso negado" e salvamento de senha pelo navegador

## Problema 1 — Flash de "acesso negado" / "Sem empresa vinculada"

**Causa:** em `src/hooks/useAuth.tsx`, quando o `onAuthStateChange` dispara após o login, o estado `user` é atualizado imediatamente, mas `loadProfile()` (que busca `role`, `tenantId` e `permissions`) roda de forma assíncrona **sem** marcar `loading=true`. Nesse intervalo, `AdminRoute`/`ClientRoute` em `src/App.tsx` veem `user` presente + `role=null` + `tenantId=null` e renderizam a tela de bloqueio por uma fração de segundo antes do perfil chegar.

**Correção:**

1. Em `useAuth.tsx`, adicionar um estado `profileLoading` (separado do `loading` inicial):
   - `setProfileLoading(true)` antes de chamar `loadProfile()` no `onAuthStateChange` (e também na carga inicial).
   - `setProfileLoading(false)` no `.then(apply)`.
2. Expor `loading` combinado: `loading: loading || profileLoading` no contexto, para que as rotas continuem mostrando o `<Loading />` global enquanto o perfil chega.
3. Como rede de segurança em `App.tsx`, em `AdminRoute` e `ClientRoute`, quando `user` existe mas `role` ainda é `null`, renderizar `<Loading />` em vez do bloco de "acesso negado" / "Sem empresa vinculada". O bloco só aparece quando temos certeza (role definida e divergente).

Resultado: o usuário vê "Carregando..." → painel, sem o flash.

## Problema 2 — Navegador não oferece salvar a senha

**Causa:** o formulário em `src/pages/Login.tsx` não tem os atributos que gerenciadores de senha (Chrome, Safari, 1Password etc.) usam para detectar credenciais. Sem `name` e `autocomplete` corretos, o navegador não pergunta "Deseja salvar a senha?" e não preenche nos próximos logins.

**Correção em `src/pages/Login.tsx`:**

1. No `<input>` de email: adicionar `name="email"` e `autoComplete="username"`.
2. No `<input>` de senha: adicionar `name="password"` e `autoComplete="current-password"`.
3. Garantir que o `<form>` envolve os dois inputs e o botão de submit (já envolve) — mantém o submit por Enter funcionando, que é o gatilho que o navegador usa para oferecer o save.

Não há mudança no backend: a senha já é gravada corretamente no `auth.users` pelo Supabase. O problema é só de hint para o navegador armazenar localmente.

## Validação

- Logout → login: confirmar que não há mais flash da mensagem vermelha antes do painel carregar.
- Login pela primeira vez em janela limpa: Chrome deve perguntar "Salvar senha para zayloia.com?".
- Próximo login: campos devem ser auto-preenchidos.

## Arquivos alterados

- `src/hooks/useAuth.tsx` — estado `profileLoading` e `loading` combinado.
- `src/App.tsx` — `AdminRoute`/`ClientRoute` mostram `<Loading />` enquanto `user` existe mas `role` ainda não foi resolvida.
- `src/pages/Login.tsx` — atributos `name` e `autoComplete` nos inputs.
