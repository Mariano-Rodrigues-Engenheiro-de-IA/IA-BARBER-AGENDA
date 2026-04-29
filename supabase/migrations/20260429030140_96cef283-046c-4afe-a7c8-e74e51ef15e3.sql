-- Atualizar prompt do agente da Barbearia do Régis: nova seção de agendamento via ferramentas Frizzar
UPDATE public.tenants
SET agent_system_prompt = $PROMPT$# 🤖 PROMPT PRINCIPAL — RECEPCIONISTA VIRTUAL BARBEARIA DO RÉGIS
$PROMPT$,
    updated_at = now()
WHERE id = '2f51032e-f7af-4eb2-9e32-b042515e0bf5';