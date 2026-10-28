/**
 * src/services/acompanhamento/render.js
 * O preenchimento dos marcadores de uma mensagem do acompanhamento.
 *
 * PURO: nada de banco, rede ou relógio do sistema — quem chama passa o
 * dia. É o que deixa os testes (`render.test.js`) rodarem sem `.env`.
 *
 * ## Falha fechada
 *
 * Marcador sem valor tira o modelo da vez: `preencher` devolve `texto:
 * null` e a lista do que faltou, e a régua passa ao modelo seguinte.
 * Nunca sai `{chave}` crua nem frase com buraco — "Faz  dias" é pior do
 * que mensagem nenhuma, porque o aluno lê e conclui que é robô.
 *
 * ## De onde vem cada valor
 *
 * O Prescrev diz, na lista de marcadores que publica com os modelos, a
 * fonte de cada um:
 *
 *   ficha  vem pronto em `ficha.marcadores` — exceto {dias_avaliacao}, que
 *          muda todo dia e se conta aqui de `ficha.proxima_avaliacao`
 *   evo    o APAC preenche com o que lê do EVO, na régua: {dias} do aviso
 *          "Sem presença"; {dia_retorno}, {atividade_retorno} e {modalidade}
 *          da agenda; {treinos_ciclo} e {minimo_ciclo} do treino; e
 *          {professor}, do treino, quando o card não escolheu ninguém (D3)
 *
 * ## As sessões do AQUAP (M2 do PLANO_MODELOS do Prescrev, 27/10/2026)
 *
 * {presencas_quinzena}, {presencas_mes} e {semanas_ativas} saem do
 * comportamento da ficha; {dia} e {hora_combinada}, da próxima sessão
 * agendada na agenda da ficha. Os dois só valem com a carga do sync de até
 * 2 dias (`DADO_FRESCO_DIAS`): "4 treinos nas últimas duas semanas" contado
 * no domingo e lido na sexta não é dado verdadeiro, e a sessão agendada há
 * uma semana pode ter sido desmarcada. As contagens só valem de 2 para
 * cima — "1 treinos" não é frase, e reconhecer um treino só não é o
 * assunto do degrau. Sem valor, o modelo sai da vez, e o seguinte entra.
 */

/**
 * O primeiro nome como se escreve numa mensagem — a mesma regra do Prescrev
 * (`primeiroNome` em acompanhamento/ficha.ts): "VANESSA ROBERT" vira "Vanessa".
 * Para o nome do professor que vem do EVO, que chega como foi cadastrado.
 */
export function primeiroNome(nome) {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (!p) return '';
  if (p !== p.toUpperCase() && p !== p.toLowerCase()) return p;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** Dias de `de` até `ate`, as duas datas 'AAAA-MM-DD'. Negativo se `ate` já passou. */
export function diasEntre(de, ate) {
  const [a, b] = [de, ate].map(d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Até quantos dias de idade a carga do sync vale para os marcadores das sessões. */
export const DADO_FRESCO_DIAS = 2;

/** O dia, em São Paulo, de um instante ISO. */
export const diaSP = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

const SEMANA = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'];
/** "na sexta, 02/10" — com a preposição, que muda com o dia. */
export const diaPorExtenso = (dia) =>
  `${SEMANA[new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10))).getUTCDay()]}, ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/** {hora_combinada}: '07:00' → "às 7h"; '18:30:00' → "às 18h30". */
export function horaPorExtenso(hora) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hora ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  return h === 1 ? `à 1h${m[2] === '00' ? '' : m[2]}` : `às ${h}h${m[2] === '00' ? '' : m[2]}`;
}

/** A carga é de hoje, de ontem ou de anteontem (e não do futuro). */
const fresco = (dia, hoje) => !!dia && dia <= hoje && diasEntre(dia, hoje) <= DADO_FRESCO_DIAS;
/** Contagem que vira frase: de 2 para cima. */
const contagem = (n) => (typeof n === 'number' && n >= 2 ? String(n) : null);

/**
 * Os valores dos marcadores para uma ficha, no dia `hoje`.
 *
 * {dias_avaliacao} só tem valor de 2 dias para cima: "faltam 1 dias" e
 * "faltam 0 dias" não são frase, e nessa semana quem fala da reavaliação
 * é a mensagem de reavaliação.
 *
 * {proxima_avaliacao} perde o valor quando a data passa. A ficha a traz
 * pronta ("21/11") e só muda quando o Prescrev grava a avaliação seguinte;
 * sem isto, "sua reavaliação é em 21/11" sairia em 28/11 — foi o que a
 * primeira simulação mostrou.
 *
 * Os das sessões do AQUAP (M2), só com a carga fresca: ver o cabeçalho.
 */
export function valoresDaFicha(ficha, hoje) {
  const valores = { ...(ficha.marcadores ?? {}) };
  const ate = ficha.proxima_avaliacao ? diasEntre(hoje, ficha.proxima_avaliacao) : null;
  valores.dias_avaliacao = ate !== null && ate >= 2 ? String(ate) : null;
  if (ate === null || ate < 0) valores.proxima_avaliacao = null;

  const c = ficha.comportamento;
  const contado = fresco(c?.ate, hoje);
  valores.presencas_quinzena = contado ? contagem(c.presencas?.d14) : null;
  valores.presencas_mes = contado ? contagem(c.presencas?.d28) : null;
  valores.semanas_ativas = contado ? contagem(c.presencas?.semanas_ativas_4) : null;

  // A próxima sessão agendada: depois de hoje, para a frase não falar de
  // um treino que pode já ter passado quando a mensagem sair.
  const carga = ficha.agenda?.sincronizada_em ? diaSP(ficha.agenda.sincronizada_em) : null;
  const proxima = fresco(carga, hoje)
    ? (ficha.agenda.sessoes ?? []).filter(s => s.dia > hoje)
      .sort((a, b) => (a.dia + (a.hora ?? '')).localeCompare(b.dia + (b.hora ?? '')))[0] ?? null
    : null;
  valores.dia = proxima ? (diasEntre(hoje, proxima.dia) === 1 ? 'amanhã' : diaPorExtenso(proxima.dia)) : null;
  valores.hora_combinada = proxima ? horaPorExtenso(proxima.hora) : null;
  return valores;
}

/**
 * Preenche os marcadores de um texto.
 *
 * Falha fechada também com o que parece marcador e não é: `{Nome}` ou
 * `{presencas_14}` não se trocam (a chave é de minúsculas e sublinhado), e
 * sairiam crus. O texto que ainda tem chaves depois de preenchido não sai.
 * @returns {{ texto: string|null, faltam: string[] }}
 */
export function preencher(texto, valores) {
  const faltam = [];
  const saida = texto.replace(/\{([a-z_]+)\}/g, (inteiro, chave) => {
    const v = valores[chave];
    if (v === null || v === undefined || String(v).trim() === '') {
      faltam.push(chave);
      return inteiro;
    }
    return String(v);
  });
  if (!faltam.length) {
    for (const m of saida.matchAll(/\{([^{}\s]+)\}/g)) faltam.push(m[1]);
  }
  return faltam.length ? { texto: null, faltam: [...new Set(faltam)] } : { texto: saida, faltam: [] };
}
