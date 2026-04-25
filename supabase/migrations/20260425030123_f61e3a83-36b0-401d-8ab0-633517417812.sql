-- Champion (Danilo) — limpeza das custom_tools e correção do system prompt
-- 1) Remover a ferramenta "ENVIAR_FOTO_PLANOS" (desabilitada, conflito de name=enviar_pix com a do PIX)
-- 2) Corrigir endereço (Marial → Marialva) e lat/long para coordenadas reais de Marialva-PR
--    Coordenadas aproximadas de R. Formosa, 648 - Centro, Marialva-PR: -23.4895, -51.7949
-- 3) Remover frase contraditória da seção 5 do system prompt (remarcação por WhatsApp)
-- 4) Remover do agent_knowledge_base toda a seção que orienta a IA a chamar ENVIAR_FOTO_PLANOS

UPDATE tenants
SET
  -- Filtra a ferramenta enviar_pix do tipo send_image (foto planos) e atualiza a localização
  agent_settings = jsonb_set(
    agent_settings,
    '{custom_tools}',
    (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN tool->>'id' = '6c820734-e26c-4330-a627-e28de80a0ed9' THEN
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(tool, '{config,address}', '"R. Formosa, 648 - Centro, Marialva - PR, 86990-000"'::jsonb),
                    '{config,name}', '"Barbearia Champion"'::jsonb
                  ),
                  '{config,latitude}', '-23.4895'::jsonb
                ),
                '{config,longitude}', '-51.7949'::jsonb
              )
            ELSE tool
          END
        ),
        '[]'::jsonb
      )
      FROM jsonb_array_elements(agent_settings->'custom_tools') AS tool
      WHERE tool->>'id' <> 'fd699a29-9362-4b4e-8727-1f58c9689907'  -- remove ENVIAR_FOTO_PLANOS
    )
  ),
  -- Remove a frase contraditória da seção 5 do system prompt
  agent_system_prompt = REPLACE(
    agent_system_prompt,
    E'\n\nOu se preferir, pode remarcar aqui pelo WhatsApp mesmo — é só me informar o dia e horário que preferir!',
    ''
  ),
  updated_at = NOW()
WHERE id = '386a2ab7-6715-4f5a-a59b-e139abcdb75d';

-- Remove do agent_knowledge_base a seção inteira de ENVIAR_FOTO_PLANOS (entre os marcadores)
UPDATE tenants
SET agent_knowledge_base = REGEXP_REPLACE(
      agent_knowledge_base,
      E'## 📸 FERRAMENTA: "ENVIAR_FOTO_PLANOS".*?(?=## 🎯 FLUXO DE ATENDIMENTO — PLANOS)',
      '',
      'gs'
    ),
    updated_at = NOW()
WHERE id = '386a2ab7-6715-4f5a-a59b-e139abcdb75d';

-- Remove menções residuais de "ENVIAR_FOTO_PLANOS" e "Acione a ferramenta ENVIAR_FOTO_PLANOS"
UPDATE tenants
SET agent_knowledge_base = REGEXP_REPLACE(
      agent_knowledge_base,
      E'.*ENVIAR_FOTO_PLANOS.*\n?',
      '',
      'g'
    ),
    updated_at = NOW()
WHERE id = '386a2ab7-6715-4f5a-a59b-e139abcdb75d';