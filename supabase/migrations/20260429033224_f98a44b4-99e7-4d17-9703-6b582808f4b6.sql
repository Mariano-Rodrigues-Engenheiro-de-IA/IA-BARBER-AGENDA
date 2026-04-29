UPDATE public.tenants
SET agent_system_prompt = REPLACE(
  agent_system_prompt,
  '3. **listar_profissionais** com a lista de serviços escolhidos no formato `[{ "codigo": 67511 }, { "codigo": 67510 }]`.',
  '3. **listar_profissionais** com a lista de serviços escolhidos no formato `[{ "codigo": 67511 }, { "codigo": 67510 }]`.
   - ⚠️ Se a resposta vier com `profissionais: []` ou array vazio, NÃO escale para humano. Significa apenas que ninguém tem horário livre nas próximas horas (ex.: madrugada, fora do expediente). Nesse caso, pergunte ao cliente uma DATA específica (ex.: "amanhã", "sexta", "30/04") e siga direto para `listar_horarios` — se o cliente já indicou um profissional pelo nome, use o codigo dele de uma chamada anterior; senão, peça ao cliente o nome do profissional preferido.'
)
WHERE id = '2f51032e-f7af-4eb2-9e32-b042515e0bf5';