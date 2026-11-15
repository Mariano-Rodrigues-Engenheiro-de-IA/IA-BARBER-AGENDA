ALTER TABLE public.platform_connection_alert_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.platform_connection_alert_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_connection_alert_config TO authenticated;
GRANT ALL ON TABLE public.platform_connection_alert_config TO service_role;

CREATE POLICY "Settings access can read connection alert config"
ON public.platform_connection_alert_config
FOR SELECT TO authenticated
USING (public.staff_has_module((SELECT auth.uid()), 'settings'));

CREATE POLICY "Settings access can create connection alert config"
ON public.platform_connection_alert_config
FOR INSERT TO authenticated
WITH CHECK (public.staff_has_module((SELECT auth.uid()), 'settings'));

CREATE POLICY "Settings access can update connection alert config"
ON public.platform_connection_alert_config
FOR UPDATE TO authenticated
USING (public.staff_has_module((SELECT auth.uid()), 'settings'))
WITH CHECK (public.staff_has_module((SELECT auth.uid()), 'settings'));