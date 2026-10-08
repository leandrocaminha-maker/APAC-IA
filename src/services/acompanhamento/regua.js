/**
 * src/services/acompanhamento/regua.js
 * A régua do acompanhamento: o que sai hoje para um aluno, e por quê.
 *
 * PURO, como `render.js`: recebe a ficha, os modelos, o histórico e o dia,
 * e devolve a decisão. O banco, a hora e o teto ficam em `ensaio.js`.
 *
 * ## As situações, na ordem em que se decidem (uma por dia)
 *
 *   boas_vindas      a primeira mensagem. No envio real, quem a manda é a
 *                    ativação pelo código (etapa A5), em resposta ao aluno; no
 *                    ensaio, ela abre a linha do tempo de quem acabou de chegar.
 *   ausencia         o EVO avisou (automação "Sem presença" do CRM, webhook
 *                    guardado em crm_evo_webhook_events) que o aluno passou do
 *                    limite da frequência combinada — o maior entre 5 e
 *                    14 ÷ frequência, em dias. Decisão do responsável em
 *                    08/10/2026: a carga semanal da agenda não serve para o
 *                    dia a dia da ausência.
 *   retorno          a primeira presença na agenda depois de uma ausência
 *                    avisada. A mensagem diz o dia e a atividade da volta: a
 *                    agenda é semanal, e a volta pode ter sido há dias.
 *   reavaliacao      7 dias antes da próxima avaliação, uma vez por data.
 *   sem_agendamento  modalidades do programa sem nenhum agendamento na agenda
 *                    do EVO em 3 semanas, passadas 3 semanas da entrega do
 *                    relatório. Todas numa mensagem só, e não se repete em 3
 *                    semanas — uma por modalidade, em dias seguidos, foi o que
 *                    a primeira simulação mostrou, e é insistência.
 *   rotina           passou a cadência do aluno desde a última mensagem. Toda
 *                    mensagem conta, de qualquer situação: evento zera o
 *                    relógio da rotina (§5.4 do plano).
 *
 * ## A agenda é semanal
 *
 * As sessões vêm da ficha (`ficha.agenda`), carregadas pelo sync de domingo
 * do AQUAP (D11). Presença só conta em aula FINALIZADA: no EVO "Presente" é
 * o valor padrão, e a aula que ainda não aconteceu pode vir marcada.
 *
 * Por isso a ausência não sai da agenda: com dado de domingo, quem treinou
 * na terça receberia "faz 6 dias" no sábado. Ela vem do aviso do EVO, e a
 * agenda só confere — aviso contradito por presença na agenda não vira
 * mensagem. O que o aviso traz ainda se confere com um aluno conhecido
 * (§9.3 do plano): se `daysOffset` é o N da regra, se conta aula ou catraca,
 * e se o EVO avisa também quando a pessoa sai da lista.
 *
 * ## O que ainda não está aqui
 *
 * Ciclo em risco, mínimo cumprido, treino vencendo e "não marca no app"
 * esperam o treino de musculação do EVO; a troca da adesão pela secundária
 * quando a presença estabiliza (§5.3), também. A trilha é a principal.
 */
import { diasEntre, preencher, valoresDaFicha } from './render.js';

export const PRIORIDADE = {
  boas_vindas: 0, ausencia: 1, retorno: 2, reavaliacao: 3, sem_agendamento: 4, rotina: 5,
};

/** Quantos dias antes da próxima avaliação sai o aviso. Convenção desta casa (§5.2). */
export const REAVALIACAO_ANTES_DIAS = 7;
/** Aviso de ausência do EVO mais velho que isso não vira mensagem: o worker pode ter ficado parado. */
export const AVISO_AUSENCIA_VALE_DIAS = 2;
/** Janela da modalidade sem agendamento, e o mínimo de programa para olhá-la. */
export const SEM_AGENDAMENTO_DIAS = 21;

const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const SEMANA = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'];
/** {dia_retorno}: "na sexta, 02/10" — com a preposição, que muda com o dia. */
export const diaPorExtenso = (dia) =>
  `${SEMANA[new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10))).getUTCDay()]}, ${ddmm(dia)}`;
const diaSP = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
const maior = (a, b) => (a > b ? a : b);
const somar = (dia, n) => new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10)) + n * 86_400_000)
  .toISOString().slice(0, 10);

/** O limite de ausência para a frequência combinada (§5.2). */
export function limiteAusencia(diasSemana) {
  return Math.max(5, Math.ceil(14 / Math.max(1, diasSemana || 1)));
}

/**
 * O que a agenda diz, no dia da carga. null sem agenda carregada.
 * `inicio` é a entrega do relatório: antes dela não havia programa.
 */
export function leituraDaAgenda(ficha) {
  if (!ficha.agenda) return null;
  const carga = diaSP(ficha.agenda.sincronizada_em);
  const inicio = ficha.relatorio_aluno?.entregue_em ? diaSP(ficha.relatorio_aluno.entregue_em) : null;
  const presentes = ficha.agenda.sessoes
    .filter(s => s.finalizada && s.presenca && s.dia <= carga)
    .sort((a, b) => (a.dia + (a.hora ?? '')).localeCompare(b.dia + (b.hora ?? '')));
  const presencas = presentes.map(s => s.dia);
  return { carga, inicio, presentes, presencas, ultimaPresenca: presencas.at(-1) ?? null };
}

/**
 * As modalidades do programa que se conferem pela agenda: com atividade do
 * EVO casada e prescritas — com frequência, ou a musculação com ciclo.
 */
export function modalidadesNaAgenda(ficha) {
  return (ficha.modalidades ?? []).filter(m => m.atividades_evo?.length
    && ((m.frequencia_semanal ?? 0) > 0 || (m.slug === 'musculacao' && (ficha.ciclos ?? []).length > 0)));
}

/**
 * Os modelos candidatos de uma situação para uma trilha. Rotina é sempre
 * da trilha; nas outras, o modelo da trilha vem antes do de 'todas'.
 */
export function candidatosDe(modelos, situacao, trilha) {
  const da = modelos.filter(m => m.situacao === situacao && m.trilha === trilha);
  if (situacao === 'rotina' || da.length) return da;
  return modelos.filter(m => m.situacao === situacao && m.trilha === 'todas');
}

/**
 * Rodízio: começa no modelo seguinte ao último usado nesta situação, para
 * a mesma pessoa não ler a mesma frase duas vezes seguidas. Modelo editado
 * no Prescrev ganha id novo, e o rodízio recomeça do primeiro.
 */
export function emRodizio(candidatos, ultimoId) {
  const i = candidatos.findIndex(m => m.id === ultimoId);
  return i < 0 ? candidatos : [...candidatos.slice(i + 1), ...candidatos.slice(0, i + 1)];
}

/**
 * Ausência pelo aviso do EVO. `sinais`: os avisos "Sem presença" deste
 * aluno, `{ dia, dias }` — `dias` é o `daysOffset` do evento, null quando o
 * EVO não o informa (aí o aviso vale, e o modelo que usa {dias} não sai).
 */
function ausencia({ ficha, anteriores, sinais, agenda, hoje }) {
  if (!ficha.frequencia) return null;
  const limite = limiteAusencia(ficha.frequencia.dias_semana);
  const inicio = ficha.relatorio_aluno?.entregue_em ? diaSP(ficha.relatorio_aluno.entregue_em) : null;
  const ultimoAviso = [...anteriores].reverse().find(h => h.situacao === 'ausencia')?.dia ?? '';
  const aviso = sinais
    .filter(x => x.dia > ultimoAviso && (!inicio || x.dia >= inicio)
      && diasEntre(x.dia, hoje) <= AVISO_AUSENCIA_VALE_DIAS && (x.dias === null || x.dias >= limite))
    .sort((a, b) => a.dia.localeCompare(b.dia)).at(-1);
  if (!aviso) return null;

  // A agenda confere: presença dentro do período que o EVO diz vazio.
  if (agenda && aviso.dias) {
    const de = somar(aviso.dia, -aviso.dias + 1);
    const contra = agenda.presencas.filter(d => d >= de && d <= aviso.dia).at(-1);
    if (contra) {
      return { situacao: null, motivo: `Aviso "Sem presença" do EVO de ${ddmm(aviso.dia)} contradito pela agenda (presença em ${ddmm(contra)}): não sai.` };
    }
  }
  const d6 = ficha.trilha.principal === 'adesao' ? ' No envio, o professor recebe o aviso junto (D6, etapa A4).' : '';
  return {
    situacao: 'ausencia',
    valores: { dias: aviso.dias ? String(aviso.dias) : null },
    motivo: `Aviso "Sem presença" do EVO em ${ddmm(aviso.dia)}` +
      (aviso.dias ? `: ${aviso.dias} dias` : ' (sem o número de dias)') +
      `; limite de ${limite} para ${ficha.frequencia.dias_semana}× por semana.${d6}`,
  };
}

function retorno({ ficha, anteriores, agenda }) {
  const aviso = [...anteriores].reverse().find(h => h.situacao === 'ausencia');
  if (!aviso || anteriores.some(h => h.situacao === 'retorno' && h.dia > aviso.dia)) return null;
  const volta = agenda.presentes.find(x => x.dia > aviso.dia);
  if (!volta) return null;
  // O nome da atividade sai do catálogo do Prescrev (a ficha o traz em cada
  // sessão); atividade fora do catálogo deixa {atividade_retorno} sem valor.
  return {
    situacao: 'retorno',
    valores: { dia_retorno: diaPorExtenso(volta.dia), atividade_retorno: volta.modalidade ?? null },
    motivo: `Presença em ${ddmm(volta.dia)}, depois do aviso de ausência de ${ddmm(aviso.dia)} (agenda de ${ddmm(agenda.carga)}).`,
  };
}

/** "A", "A e B", "A, B e C". */
export function emLista(nomes) {
  return nomes.length <= 1 ? (nomes[0] ?? '') : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`;
}

function semAgendamento({ ficha, anteriores, agenda, hoje }) {
  if (!agenda.inicio || diasEntre(agenda.inicio, hoje) < SEM_AGENDAMENTO_DIAS) return null;
  if (anteriores.some(h => h.situacao === 'sem_agendamento' && diasEntre(h.dia, hoje) < SEM_AGENDAMENTO_DIAS)) return null;
  const de = maior(somar(agenda.carga, -SEM_AGENDAMENTO_DIAS), agenda.inicio);
  if (diasEntre(de, agenda.carga) < SEM_AGENDAMENTO_DIAS) return null;   // carga antiga demais para 3 semanas de programa
  const faltam = modalidadesNaAgenda(ficha).filter(m => !ficha.agenda.sessoes
    .some(s => s.dia >= de && s.dia <= agenda.carga && m.atividades_evo.includes(s.atividade_evo)));
  if (!faltam.length) return null;
  return {
    situacao: 'sem_agendamento',
    valores: { modalidade: emLista(faltam.map(m => m.nome)) },
    motivo: `Nenhum agendamento na agenda do EVO de ${ddmm(de)} a ${ddmm(agenda.carga)}: ${faltam.map(m => m.nome).join(', ')}.`,
  };
}

/** A situação devida hoje, ou o motivo de nada estar devido. */
export function situacaoDoDia({ ficha, anteriores, sinais = [], hoje, modo }) {
  if (!anteriores.length) {
    return modo === 'ensaio'
      ? { situacao: 'boas_vindas', valores: {}, motivo: 'Primeira mensagem. No envio real, sai quando o aluno ativa pelo código.' }
      : { situacao: null, motivo: 'Aguardando a ativação pelo código.' };
  }

  const agenda = leituraDaAgenda(ficha);
  const falta = ausencia({ ficha, anteriores, sinais, agenda, hoje });
  const evento = (falta?.situacao && falta)
    || (agenda && retorno({ ficha, anteriores, agenda }))
    || reavaliacao({ ficha, anteriores, hoje })
    || (agenda && semAgendamento({ ficha, anteriores, agenda, hoje }));
  if (evento) return evento;

  const ultimo = anteriores[anteriores.length - 1];
  const desde = diasEntre(ultimo.dia, hoje);
  const cadencia = ficha.trilha.cadencia_dias;
  if (desde >= cadencia) {
    return { situacao: 'rotina', valores: {}, motivo: `${desde} dia(s) desde a última mensagem; cadência de ${cadencia}.` };
  }
  const nota = (falta && !falta.situacao ? ` ${falta.motivo}` : '') + (!agenda ? ' Agenda do EVO ainda não carregada.' : '');
  return {
    situacao: null,
    motivo: `Próxima rotina em ${cadencia - desde} dia(s): cadência de ${cadencia}, última em ${ddmm(ultimo.dia)}.${nota}`,
  };
}

function reavaliacao({ ficha, anteriores, hoje }) {
  const prox = ficha.proxima_avaliacao;
  if (!prox) return null;
  const ate = diasEntre(hoje, prox);
  const jaAvisou = anteriores.some(h => h.situacao === 'reavaliacao'
    && h.dia <= prox && diasEntre(h.dia, prox) <= REAVALIACAO_ANTES_DIAS);
  if (ate < 0 || ate > REAVALIACAO_ANTES_DIAS || jaAvisou) return null;
  return {
    situacao: 'reavaliacao',
    valores: {},
    motivo: ate === 0 ? `Reavaliação hoje (${ddmm(prox)}).` : `Reavaliação em ${ate} dia(s), em ${ddmm(prox)}.`,
  };
}

/**
 * A decisão do dia para um aluno.
 *
 * @param {object} p
 * @param {object} p.ficha      a ficha publicada pelo Prescrev
 * @param {object[]} p.modelos  os modelos publicados pelo Prescrev
 * @param {object[]} p.historico as mensagens que contam (no ensaio, as
 *   simuladas; no envio, as enviadas): `{ dia, situacao, modelo_id, valores }`
 * @param {object[]} [p.sinais] os avisos "Sem presença" do EVO para este
 *   aluno: `{ dia, dias }`
 * @param {string} p.hoje       'AAAA-MM-DD', em São Paulo
 * @param {'ensaio'|'envio'} p.modo
 * @returns {{ status: 'simulado'|'pendente'|'bloqueado'|'nada', situacao: string|null, trilha: string,
 *   modelo_id: string|null, texto: string|null, valores: object, motivo: string, bloqueios: string[] }}
 */
export function decidir({ ficha, modelos, historico, sinais = [], hoje, modo }) {
  const trilha = ficha.trilha.principal;
  const base = { trilha, situacao: null, modelo_id: null, texto: null, valores: {}, bloqueios: [] };

  if (ficha.estado?.encerrado) {
    return { ...base, status: 'nada', motivo: 'Acompanhamento encerrado no Prescrev.' };
  }
  if (ficha.estado?.pausado_ate && ficha.estado.pausado_ate >= hoje) {
    return { ...base, status: 'nada', motivo: `Pausado até ${ddmm(ficha.estado.pausado_ate)}.` };
  }

  // Só o que veio antes de hoje: rodar o ensaio duas vezes no mesmo dia
  // não pode fazer o relógio andar duas vezes.
  const anteriores = historico.filter(h => h.dia < hoje).sort((a, b) => a.dia.localeCompare(b.dia));
  const { situacao, motivo, valores: doDia } = situacaoDoDia({ ficha, anteriores, sinais, hoje, modo });
  if (!situacao) return { ...base, status: 'nada', motivo };

  const valores = { ...valoresDaFicha(ficha, hoje), ...doDia };
  const ultimoId = [...anteriores].reverse().find(h => h.situacao === situacao)?.modelo_id ?? null;
  const candidatos = emRodizio(candidatosDe(modelos, situacao, trilha), ultimoId);

  const faltam = new Set();
  for (const m of candidatos) {
    // 'nao' = marcador que nada preenche: fica para o professor mandar à mão.
    if (m.envio === 'nao') continue;
    const r = preencher(m.texto, valores);
    if (r.texto) {
      return {
        ...base, situacao, modelo_id: m.id, texto: r.texto, valores,
        status: modo === 'ensaio' ? 'simulado' : 'pendente', motivo,
      };
    }
    r.faltam.forEach(f => faltam.add(f));
  }

  const porque = !candidatos.length
    ? `Nenhum modelo de ${situacao} para a trilha ${trilha}.`
    : `Nenhum modelo de ${situacao} com todos os marcadores` +
      (faltam.size ? `: falta ${[...faltam].map(f => `{${f}}`).join(', ')}.` : '.');
  return { ...base, situacao, valores, status: 'bloqueado', motivo, bloqueios: [porque] };
}

// São Paulo é UTC-3 o ano todo — a mesma constante de followup.js.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** Minuto do dia em que a mensagem de cada período sai, antes de presa à janela. */
const INICIO_DO_PERIODO = { 'manhã': 9 * 60, tarde: 14 * 60, noite: 18 * 60 };

/**
 * A hora prevista de uma mensagem: o começo do período preferido, presa à
 * janela do dia, mais um deslocamento fixo por aluno (0 a 40 min) para as
 * mensagens não saírem todas no mesmo minuto.
 */
export function horaPrevista(ficha, hoje, janela) {
  const base = INICIO_DO_PERIODO[ficha.marcadores?.periodo] ?? 10 * 60;
  let h = 0;
  for (const c of ficha.cliente_id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const minuto = Math.min(Math.max(base, janela.inicioMin) + (h % 41), janela.fimMin - 15);
  const [a, m, d] = hoje.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 0, minuto) - OFFSET_SP_MS);
}
