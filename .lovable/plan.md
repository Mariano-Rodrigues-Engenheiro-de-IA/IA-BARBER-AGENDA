## Trava contra erro de data no agendamento (Frizzar)

### Problema
Na Ícaro Frisar, a IA listou horários para um dia e agendou em outro (27 vs 28). Hoje a tool `agendar` da Frizzar valida apenas o **horário** dentro de `horariosLivres`, mas **não valida a data** — então qualquer `dia` errado passa direto.

### Escopo
Somente provider **Frizzar**. Arquivo único: `supabase/functions/whatsapp-webhook/index.ts`.
Sem migration, sem mexer em Trinks/OneBeleza/Bemp/Zaylo, sem mudança de UI.

### Mudanças

**1. Memória da última `listar_horarios` por conversa**
Map in-process `frizzarLastListed` chaveado por `tenantId:phoneNumber:profissionalId` armazenando `{ dia, listedAt }`. Sobrevive entre invocações da mesma instância warm (cobre o caso real de listar→agendar em sequência).

**2. Handler `listar_horarios`**
Após retornar normalizado, gravar `{ dia: args.data, listedAt: Date.now() }` no Map.

**3. Handler `agendar` — pré-validação de data**
Antes de bater na API Frizzar, comparar `args.dia` com a última data consultada para aquele `profissionalId`. Se diferente (e gravação recente, <30min), bloquear com erro estruturado:
```
{
  error: "Data divergente: você listou horários para {ultimaData} mas tentou agendar em {args.dia}. Confirme a data com o cliente e chame listar_horarios para a nova data ANTES de agendar.",
  ultimaDataListada, diaSolicitado
}
```

**4. Reforço no prompt (`buildFrizzarPromptSection`)**
Adicionar bloco "🚨 REGRA ABSOLUTA — DATA NO AGENDAR" instruindo:
- O `dia` em `agendar` deve ser EXATAMENTE o da última `listar_horarios`.
- Se cliente trocar de data, refazer `listar_horarios` antes.
- Sempre confirmar em voz alta: "Posso agendar para [DD/MM] às [HH:mm]?".
- Sistema bloqueia divergência.

### Arquivos
- `supabase/functions/whatsapp-webhook/index.ts` — 3 trechos (linhas ~7123, ~7472, ~7509, ~7336).
