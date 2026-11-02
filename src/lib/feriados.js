/**
 * src/lib/feriados.js
 * Os feriados em que a academia não abre — e em que nada parte dela.
 *
 * ## Por que existe (01/11/2026)
 *
 * A janela de contato só sabia do dia da semana: domingo fechado, sábado
 * até as 13h. Feriado era dia comum, e 02/11 (Finados, segunda) teria
 * follow-up, campanha e acompanhamento saindo como numa segunda qualquer.
 * A tabela de horários (`informacoes-gerais.md`) diz o contrário:
 * "Domingo e feriados — não abre".
 *
 * ## O que entra
 *
 *  - Nacionais fixos, incluindo 20/11 (Lei 14.759/2023).
 *  - Segunda e terça de Carnaval e Sexta-feira Santa, calculadas a partir
 *    da Páscoa.
 *  - Estado de São Paulo: 09/07.
 *  - Município de São Paulo: 25/01 e Corpus Christi.
 *  - Recessos da academia (`RECESSOS`): 21/12/2026 a 03/01/2027.
 *  - O que vier em `FERIADOS_EXTRA` (env), separado por vírgula:
 *    `AAAA-MM-DD` para uma data só (ponte) ou `MM-DD` para todo ano.
 *
 * Datas são de São Paulo (UTC-3 o ano todo, ver `followup.js`).
 */

const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** `MM-DD` → nome. */
const FIXOS = {
  '01-01': 'Confraternização Universal',
  '01-25': 'Aniversário de São Paulo',
  '04-21': 'Tiradentes',
  '05-01': 'Dia do Trabalho',
  '07-09': 'Revolução Constitucionalista',
  '09-07': 'Independência',
  '10-12': 'Nossa Senhora Aparecida',
  '11-02': 'Finados',
  '11-15': 'Proclamação da República',
  '11-20': 'Dia da Consciência Negra',
  '12-25': 'Natal',
};

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em UTC à meia-noite. */
export function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const iso = (d) => d.toISOString().slice(0, 10);
const somarDias = (d, n) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);

function moveis(ano) {
  const p = pascoa(ano);
  return {
    // Segunda e terça de Carnaval: a academia não abre (01/11/2026).
    [iso(somarDias(p, -48))]: 'Carnaval',
    [iso(somarDias(p, -47))]: 'Carnaval',
    [iso(somarDias(p, -2))]: 'Sexta-feira Santa',
    [iso(somarDias(p, 60))]: 'Corpus Christi',
  };
}

/**
 * Recessos da academia: `[início, fim]`, os dois inclusive, `AAAA-MM-DD`.
 * Todo dia do intervalo vale como feriado.
 */
const RECESSOS = [
  ['2026-12-21', '2027-01-03', 'Recesso de fim de ano'],
];

function recessoDe(dia) {
  const r = RECESSOS.find(([ini, fim]) => dia >= ini && dia <= fim);
  return r ? r[2] : null;
}

function extras(texto = process.env.FERIADOS_EXTRA || '') {
  const unicos = new Set();
  const anuais = new Set();
  for (const item of String(texto).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item)) unicos.add(item);
    else if (/^\d{2}-\d{2}$/.test(item)) anuais.add(item);
  }
  return { unicos, anuais };
}

/** O dia de São Paulo (`AAAA-MM-DD`) em que `data` cai. */
export function diaSP(data) {
  return iso(new Date(new Date(data).getTime() + OFFSET_SP_MS));
}

/**
 * O nome do feriado em que `data` cai (dia de São Paulo), ou `null`.
 * Aceita `Date`, timestamp ou a string `AAAA-MM-DD`.
 */
export function feriadoDe(data, { extra } = {}) {
  const dia = typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : diaSP(data);
  const mmdd = dia.slice(5);
  if (FIXOS[mmdd]) return FIXOS[mmdd];
  const movel = moveis(Number(dia.slice(0, 4)))[dia];
  if (movel) return movel;
  const recesso = recessoDe(dia);
  if (recesso) return recesso;
  const x = extras(extra);
  if (x.unicos.has(dia) || x.anuais.has(mmdd)) return 'Feriado (FERIADOS_EXTRA)';
  return null;
}

/** `data` cai num feriado? */
export function ehFeriado(data, opts) {
  return feriadoDe(data, opts) !== null;
}

export const feriados = { feriadoDe, ehFeriado, pascoa, diaSP };

