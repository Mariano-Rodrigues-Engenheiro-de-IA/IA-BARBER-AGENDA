## Plano

1. **Corrigir a corrida pós-login no auth**
   - Ajustar `useAuth` para não expor `user` às rotas enquanto `role`, `tenantId` e permissões ainda estão carregando.
   - Criar/usar um estado explícito de prontidão, por exemplo `authReady` ou `profileReady`, para diferenciar:
     - sessão encontrada
     - perfil/permissões realmente carregados

2. **Segurar o redirecionamento da tela `/login`**
   - Hoje a rota pode redirecionar assim que existe `user`, antes de saber se ele é cliente ou admin.
   - Alterar para redirecionar apenas quando o perfil estiver pronto:
     - cliente → `/app`
     - admin → `/`
   - Enquanto o perfil carrega, mostrar só `Carregando...`.

3. **Eliminar qualquer renderização intermediária de bloqueio**
   - Garantir que `AdminRoute` e `ClientRoute` nunca avaliem permissão enquanto o auth/perfil estiver carregando.
   - Para usuário cliente tentando cair na rota admin `/`, redirecionar silenciosamente para `/app`, sem tela de erro.

4. **Validar contra o site publicado**
   - Depois da implementação, testar o fluxo no domínio publicado, não só no preview.
   - Confirmar que o texto “Acesso negado” não aparece no DOM/tela durante o login.
   - Confirmar que o usuário cliente entra direto no painel.

5. **Publicar/atualizar o frontend**
   - Como o problema acontece no site publicado, a correção de frontend só vale no domínio final depois de atualizar a publicação.
   - Backend já foi corrigido automaticamente antes; esta etapa é para garantir que o JavaScript novo esteja no site publicado.

## Observação
O banco já tem o vínculo correto do usuário cliente com a empresa e as permissões de leitura foram corrigidas. O problema restante é o timing do frontend publicado durante o redirecionamento pós-login.