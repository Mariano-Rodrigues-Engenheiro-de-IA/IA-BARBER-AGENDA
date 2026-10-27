// Cálculo de horários livres da Trinks — funções puras, sem imports.
//
// A Trinks devolve, por profissional, `intervalosVagos` (blocos livres) e
// `horariosVagos` (inícios possíveis numa grade fixa, em geral de 20 em 20 min:
// inicio + k*passo, desde que inicio+duração caiba até o fim do bloco).
// Verificado nos logs da Bendita (02/11, 60 min) e do Thallys (26/10, 80 min).
//
// Na REMARCAÇÃO, o agendamento atual do cliente aparece como ocupado, então a
// Trinks não oferece horários que invadem a própria janela dele. Aqui a janela
// atual é somada aos blocos livres e os novos inícios possíveis são gerados.

export interface Intervalo {
  inicio: string;
  fim: string;
}

export const toMin = (h: string): number => {
  const [hh, mm] = String(h).slice(0, 5).split(":").map(Number);
  return hh * 60 + mm;
};

export const fromMin = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Passo da grade: menor diferença positiva entre horários consecutivos. Padrão 20. */
export function inferirPasso(profissionais: Array<{ horariosVagos?: string[] }>): number {
  let menor = Infinity;
  for (const p of profissionais) {
    const hs = (p.horariosVagos || []).map(toMin).sort((a, b) => a - b);
    for (let i = 1; i < hs.length; i++) {
      const d = hs[i] - hs[i - 1];
      if (d > 0 && d < menor) menor = d;
    }
  }
  return Number.isFinite(menor) && menor >= 5 && menor <= 60 ? menor : 20;
}

/** Ordena e funde blocos que se sobrepõem ou se encostam. */
export function fundirIntervalos(lista: Intervalo[]): Intervalo[] {
  const blocos = lista
    .map((i) => ({ a: toMin(i.inicio), b: toMin(i.fim) }))
    .filter((i) => Number.isFinite(i.a) && Number.isFinite(i.b) && i.b > i.a)
    .sort((x, y) => x.a - y.a);
  const out: Array<{ a: number; b: number }> = [];
  for (const bl of blocos) {
    const ult = out[out.length - 1];
    if (ult && bl.a <= ult.b) ult.b = Math.max(ult.b, bl.b);
    else out.push({ ...bl });
  }
  return out.map((i) => ({ inicio: fromMin(i.a), fim: fromMin(i.b) }));
}

export interface ProfissionalHorarios {
  horariosVagos?: string[];
  intervalosVagos?: Intervalo[];
  [k: string]: unknown;
}

/**
 * Libera a janela do agendamento atual do cliente (com esse profissional) e
 * devolve os horários que passam a caber. Só ACRESCENTA inícios que invadem a
 * janela liberada; os horários que a Trinks já devolveu ficam como vieram.
 */
export function liberarJanelaDoCliente(
  prof: ProfissionalHorarios,
  janela: { inicio: string; duracao: number },
  duracaoServico: number,
  passo: number,
): { horariosVagos: string[]; intervalosVagos: Intervalo[]; acrescentados: string[] } {
  const ini = toMin(janela.inicio);
  const fim = ini + janela.duracao;
  const originais = (prof.horariosVagos || []).map((h) => String(h).slice(0, 5));
  const intervalos = fundirIntervalos([...(prof.intervalosVagos || []), { inicio: fromMin(ini), fim: fromMin(fim) }]);

  // Âncora da grade: o minuto dos horários que a Trinks já devolveu.
  const ancora = originais.length > 0 ? toMin(originais[0]) % passo : ini % passo;

  const extras: string[] = [];
  for (const bl of intervalos) {
    const a = toMin(bl.inicio);
    const b = toMin(bl.fim);
    // primeiro início >= a alinhado na grade
    let s = a + ((((ancora - a) % passo) + passo) % passo);
    for (; s + duracaoServico <= b; s += passo) {
      const invadeJanela = s < fim && s + duracaoServico > ini;
      if (invadeJanela) extras.push(fromMin(s));
    }
  }

  const horarios = Array.from(new Set([...originais, ...extras])).sort();
  return {
    horariosVagos: horarios,
    intervalosVagos: intervalos,
    acrescentados: extras.filter((h) => !originais.includes(h)).sort(),
  };
}
