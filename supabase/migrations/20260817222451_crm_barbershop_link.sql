-- Vínculo manual (configurado pelo admin) entre este tenant da IA e a
-- barbearia correspondente no CRM Zaylo — usado para o acesso sem login
-- (link mágico): quando o cliente clica "Acessar minha IA" dentro do CRM,
-- o sistema descobre qual tenant é esse e gera uma sessão automática.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS crm_barbershop_id uuid;

CREATE INDEX IF NOT EXISTS idx_tenants_crm_barbershop ON public.tenants (crm_barbershop_id);

COMMENT ON COLUMN public.tenants.crm_barbershop_id IS
  'ID da barbearia correspondente no CRM Zaylo (buzz-boost-crm) — configurado manualmente pelo admin depois que o cliente compra o Agente de IA. Usado para o acesso sem login (link mágico) a partir do CRM.';
