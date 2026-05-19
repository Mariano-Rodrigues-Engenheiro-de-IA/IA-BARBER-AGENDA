## Mudanças no painel do cliente — aba "Sua IA"

Arquivo: `src/pages/client/Ai.tsx`

1. **Remover o card "Base de conhecimento"** completamente da aba IA (mantém apenas "Personalidade e instruções da IA"). O campo `agent_knowledge_base` segue existindo no banco — só não é mais editável por esta tela.
2. **Expandir o textarea do prompt** para ocupar quase toda a altura disponível do viewport:
   - Card com `min-height: calc(100vh - 240px)` e layout flex coluna.
   - Textarea com `flex-1`, `min-h-[500px]`, `resize-none` e `font-mono text-sm` para leitura mais confortável de prompts longos.
   - Botão "Salvar" fica no rodapé do card (`w-fit`).
3. Ajustar a condição da aba IA (`tabs[]`) para depender apenas de `ai.visible` (antes era `ai.visible || kb.visible`).

Nada mais muda — sem alterações em rotas, permissões (`ai_knowledge` continua existindo para o admin), Sua empresa, Integrações ou backend.
