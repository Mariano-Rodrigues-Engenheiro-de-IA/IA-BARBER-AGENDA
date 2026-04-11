

# Melhorias de Layout — Zaylo IA

## Mudanças solicitadas

1. **Logo**: Substituir o ícone de tesoura (Scissors) pela logo enviada — no sidebar e na tela de login
2. **Nome**: "AgendaIA" → "Zaylo IA" (sidebar + login)
3. **Tenants → Empresas**: Renomear em todo o painel (menu, títulos, botões, textos, dashboard cards)

## Ideias de melhoria de layout e UX

4. **Breadcrumbs**: Adicionar navegação breadcrumb no topo de cada página (ex: "Empresas > Editar Barbearia do Régis")
5. **Skeleton loading**: Substituir textos "Carregando..." por skeletons animados nos cards e tabelas
6. **Avatar do usuário**: Mostrar iniciais do e-mail em um avatar no rodapé do sidebar, com dropdown para perfil/sair
7. **Contadores no menu**: Badges com contagem ao lado de "Empresas" (ex: "12") e "Monitor IA" (ex: "3 erros")
8. **Responsividade mobile**: Sidebar colapsável com hamburger menu para telas menores
9. **Página de boas-vindas no Dashboard**: Cards com ações rápidas (Nova Empresa, Ver Logs, Configurações) em vez de só estatísticas
10. **Tema de cores na tabela**: Linhas alternadas com leve diferença de fundo para facilitar leitura

## Arquivos afetados

- `src/components/AdminLayout.tsx` — Logo, nome, menu labels, avatar, badges
- `src/pages/Login.tsx` — Logo, nome
- `src/pages/Tenants.tsx` — Renomear "Tenant" → "Empresa" em todos os textos
- `src/pages/Dashboard.tsx` — Renomear labels, adicionar ações rápidas
- `src/pages/TenantForm.tsx` — Título do formulário
- `public/` — Arquivo da logo
- `index.html` — Favicon (se quiser usar a logo)

## Aguardando

- **Imagem da logo** para prosseguir com a implementação

