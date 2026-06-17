GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT ON public.tenant_users TO authenticated;
GRANT ALL ON public.tenant_users TO service_role;

GRANT SELECT ON public.tenant_permissions TO authenticated;
GRANT ALL ON public.tenant_permissions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;