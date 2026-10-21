// Trava de nome do cadastrar_cliente — apoio para provedores que NÃO são One Beleza.
//
// Bug real 20/10/2026 (Thallys Barber e Bendita Barber Club, Trinks): a trava só
// aceitava o nome quando a ÚLTIMA mensagem do cliente, inteira, parecia um nome.
// Dois cenários legítimos eram barrados e a IA acabava escalando (IA OFF):
//  1) a IA usava o nome do perfil do WhatsApp (ex.: "Vini Bocchi") e o cliente não
//     tinha acabado de digitar nome nenhum;
//  2) o cliente digitava o nome junto com outras linhas no mesmo bloco de mensagens
//     ("Que estava disponível\nVilmar Boeira"), e o bloco inteiro não parece nome.
// Aqui o nome passa quando é igual ao perfil ou aparece completo na mesma sequência
// de palavras do texto do cliente, nunca pela combinação de palavras soltas.

const normalize = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** O nome corresponde ao perfil ou a uma sequência completa no texto do cliente? */
export function isNameBackedByConversation(
  argNome: unknown,
  senderName: unknown,
  userMessage: unknown,
): boolean {
  const arg = normalize(argNome);
  if (!arg) return false;

  const sender = normalize(senderName);
  if (sender && arg === sender) return true;

  const tokens = arg.split(" ");
  if (tokens.length < 2 || tokens.some((token) => token.length < 2)) return false;
  return ` ${normalize(userMessage)} `.includes(` ${arg} `);
}

// ===================== NOME DO PERFIL DE UMA PALAVRA SÓ / COM NÚMEROS =====================
// Bug real 21/10/2026 (Thallys): perfis como "Sergio" (1 palavra) ou "nicolasdaniel57035"
// (apelido com números) não passam na validação de 2 a 4 palavras, a IA era barrada e
// escalava (IA OFF), mesmo com o prompt mandando cadastrar com o nome do WhatsApp.
// Decisão do dono: aceitar o nome do perfil, tirando números e símbolos.
// Só vale quando a IA está cadastrando EXATAMENTE o nome do perfil — nome inventado
// continua barrado.

/** Nome do perfil limpo para cadastro (sem números/emojis, 1 a 4 palavras), ou null se não sobrar nome utilizável. */
export function profileNameForRegistration(senderName: unknown): string | null {
  const cleaned = String(senderName ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\s'\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ").filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 2).slice(0, 4);
  if (words.length === 0) return null;
  const name = words
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return name.replace(/[^\p{L}]/gu, "").length >= 3 ? name : null;
}

/** Se o nome que a IA passou é o do perfil do WhatsApp (com ou sem números), devolve o nome limpo para cadastrar; senão null. */
export function resolveProfileNameForRegistration(argNome: unknown, senderName: unknown): string | null {
  const profile = profileNameForRegistration(senderName);
  if (!profile) return null;
  const arg = normalize(argNome);
  if (!arg) return null;
  const argNoDigits = arg.replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
  const candidates = new Set([normalize(senderName), normalize(profile)]);
  return candidates.has(arg) || candidates.has(argNoDigits) ? profile : null;
}
