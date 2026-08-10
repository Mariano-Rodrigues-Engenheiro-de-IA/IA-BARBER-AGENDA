-- Integração com o funil (kanban) do CRM externo, usado pela IA para mover
-- leads durante a conversa. Substitui o kanban interno (crm_boards/
-- crm_leads com type="funnel") como fonte de verdade do funil de vendas —
-- as colunas "flag" (ex: IA OFF) continuam funcionando como estão, não são
-- afetadas por esta migration.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS crm_zetta_token TEXT,
  ADD COLUMN IF NOT EXISTS crm_zetta_funnel_id TEXT,
  ADD COLUMN IF NOT EXISTS crm_zetta_funnel_name TEXT,
  ADD COLUMN IF NOT EXISTS crm_zetta_stages JSONB;

COMMENT ON COLUMN tenants.crm_zetta_stages IS
  'Cache das etapas do funil escolhido: [{id, name}]. Usado para montar as ferramentas de mover lead sem precisar consultar a API externa a cada mensagem de conversa — atualizado sempre que o funil é (re)conectado na tela de configuração.';

COMMENT ON COLUMN tenants.crm_zetta_token IS
  'Bearer token do CRM externo (mesmo token usado pela extensão do Chrome do painel). Usado pelas ferramentas de mover lead que a IA usa durante a conversa.';
COMMENT ON COLUMN tenants.crm_zetta_funnel_id IS
  'ID do funil de vendas escolhido dentro do CRM externo (ex: funil "Venda Prótese Capilar"). As etapas desse funil viram as ferramentas de mover lead disponíveis para a IA.';
COMMENT ON COLUMN tenants.crm_zetta_funnel_name IS
  'Nome do funil escolhido, guardado só para exibição na tela (evita nova consulta à API externa só para mostrar o nome).';
