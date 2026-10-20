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
