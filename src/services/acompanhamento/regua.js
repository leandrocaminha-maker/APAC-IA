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
 *   ciclo_em_risco   passou a metade do treino de musculação do ciclo com
 *                    menos da metade do mínimo de treinos (presença na agenda).
 *   reavaliacao      7 dias antes da próxima avaliação, uma vez por data.
 *   minimo_cumprido  o mínimo de treinos do ciclo foi alcançado.
 *   sem_agendamento  modalidades do programa sem nenhum agendamento na agenda
 *                    do EVO em 3 semanas, passadas 3 semanas da entrega do
 *                    relatório. Todas numa mensagem só, e não se repete em 3
 *                    semanas — uma por modalidade, em dias seguidos, foi o que
 *                    a primeira simulação mostrou, e é insistência.
 *   nao_marca_app    Musculação com presença na agenda e nada marcado como
 *                    concluído no app em 14 dias: a mensagem reforça o hábito.
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
 * Situação sem modelo para a trilha do aluno é pulada, e não trava o dia:
 * "mínimo cumprido" só tem modelo nas trilhas motivacional e desafiador
 * (§5.2), por desenho.
 *
 * ## O treino de musculação
 *
 * Lido do EVO uma vez por dia (`treinos`, resumidos por `resumirTreinos`).
 * Ciclo em risco e mínimo cumprido só se conferem num treino criado DEPOIS
 * da entrega do relatório — o treino do ciclo prescrito. Treino anterior ao
 * programa não tem o mínimo do ciclo como régua: medir 32 treinos de
 * mínimo contra os dias que sobram dele seria acusar o aluno de algo que
 * ninguém combinou. O n-ésimo treino do programa é o n-ésimo ciclo.
 * Presença é a da agenda (Musculação), e não a marcada no app — que é o
 * que "não marca no app" compara.
 *
 * Fora da mensagem ao aluno, `avisos_equipe`: treino vencendo (7 dias antes
 * da validade: prescrever o ciclo seguinte), treino vencido sem treino novo
 * (até 14 dias depois), na adesão, ciclo em risco e, em todas as trilhas,
 * a modalidade sem agendamento (para avisar o professor dela). Quem
 * os manda é o briefing (A4); aviso não ocupa a mensagem do dia.
 *
 * {professor}, quando o card do Prescrev não escolheu ninguém, é quem
 * prescreveu o treino vigente no EVO (D3); sem treino, o avaliador.
 *
 * ## As fases (ficha v4, M1 do PLANO_MODELOS.md do Prescrev)
 *
 * A ficha traz `comportamento`, lido pelo Prescrev das sessões do AQUAP até
 * o dia da carga (`comportamento.ate`): a fase (ativação, início,
 * consolidação, manutenção; reavaliação e retorno por cima), o degrau do
 * assunto (N0–N4), a cadência e o teto da fase, e a etapa da ausência por
 * tempo. A régua LÊ, não calcula — a conta é uma só, em `fases.ts` de lá
 * (`fasesDaFicha` aqui) — e aplica:
 *
 *   cadência    a da fase (`fase.cadencia_dias`), no lugar da da trilha; na
 *               ativação não há rotina (null)
 *   teto        `fase.teto_mensagens` em `fase.teto_dias`: alcançado, a
 *               rotina não sai
 *   não mandar  a rotina também não sai quando já saiu mensagem de situação
 *               na semana, nem quando o aluno respondeu hoje ou ontem
 *   silêncio    etapa de ausência `silencio` ou `porta_aberta`: nada ao
 *               aluno, fora o retorno (ele voltou) e a porta aberta, que sai
 *               uma vez por ausência e depois cala até a próxima presença
 *   ausência    o limite é o prazo da ficha — 10 dias para todos (M0), que é
 *               o dia do aviso do EVO —, e não mais 14 ÷ frequência
 *   rotina      `camadasDe` escolhe pelo mais específico que casa: a semana
 *               do início (o que esperar dela, em todas as trilhas), a fase
 *               (a adesão depois do início; o N1 do retorno), o degrau (as
 *               outras trilhas depois do início); só sem nenhum, os
 *               genéricos. O rodízio é dentro de cada camada
 *
 * "Não mandar" é decisão (Nahum-Shani), e o motivo a escreve como tal. Com o
 * sync semanal o comportamento atrasa até 7 dias (a M5 o faz diário); a
 * ausência ao aluno continua vindo do aviso do EVO, que é do dia. Ficha sem
 * `comportamento` (sem carga do AQUAP) segue como antes da v4.
 *
 * ## As situações da M2 (27/10/2026)
 *
 *   primeira_ida          ativação, 3º dia aberto sem ida (a ficha diz
 *                         `fase.ativacao_etapa` 'lembrete'). Uma por entrega.
 *   lembrete_agendamento  nas 3 primeiras semanas do início (a ficha diz
 *                         `fase.lembrete_agendamento`), nada agendado na
 *                         semana: na terça, para quem treina de manhã ou à
 *                         tarde; na quarta, para quem treina à noite (decisão
 *                         2). A hora é a do período SEGUINTE ao habitual
 *                         (`periodo_envio`). Pede a agenda do dia: com a carga
 *                         de outro dia, quem agendou em cima da hora receberia
 *                         o lembrete — e o motivo diz que esperou.
 *   resultado_reavaliacao o relatório da reavaliação foi gerado
 *                         (`reavaliacao_pronta_em`), até 7 dias depois. Sem
 *                         número (decisão 9).
 *
 * As duas primeiras são EMPURRÕES: não saem no dia seguinte a outra mensagem
 * nem passam do teto da fase (`freioDoEmpurrao`). As que dependem de "não
 * veio" ou "não agendou" querem a carga de hoje ou de ontem; com a carga
 * mais velha, esperam, e o motivo diz. Aos 7 dias sem ida, o professor
 * recebe o aviso `nunca_veio` (M2; a conduta escrita é a M3).
 *
 * ## O que ainda não está aqui
 *
 * A troca da adesão pela secundária quando a presença estabiliza (§5.3). A
 * trilha é a principal. Os briefings da ausência por tempo (professor aos
 * 14 ou 15 dias, consultor aos 30) e as condutas são a M3.
 */
import { diaPorExtenso, diaSP, diasEntre, preencher, primeiroNome, valoresDaFicha } from './render.js';

export { diaPorExtenso };

export const PRIORIDADE = {
  boas_vindas: 0, ausencia: 1, retorno: 2, porta_aberta: 3, ciclo_em_risco: 4, resultado_reavaliacao: 5, reavaliacao: 6,
  minimo_cumprido: 7, primeira_ida: 8, lembrete_agendamento: 9, sem_agendamento: 10, nao_marca_app: 11, rotina: 12,
};

/** Quantos dias antes da próxima avaliação sai o aviso. Convenção desta casa (§5.2). */
export const REAVALIACAO_ANTES_DIAS = 7;
/** Aviso de ausência do EVO mais velho que isso não vira mensagem: o worker pode ter ficado parado. */
export const AVISO_AUSENCIA_VALE_DIAS = 2;
/** Janela da modalidade sem agendamento, e o mínimo de programa para olhá-la. */
export const SEM_AGENDAMENTO_DIAS = 21;
/** Aviso à equipe quando o treino vence em até este tanto de dias (§5.2). */
export const TREINO_VENCENDO_DIAS = 7;
/** Depois da validade, o aviso "vencido, sem treino novo" segue por este tanto de dias. */
export const TREINO_VENCIDO_AVISA_DIAS = 14;
/** Janela do "não marca no app", e de quanto em quanto tempo ele pode repetir. */
export const NAO_MARCA_DIAS = 14;
export const NAO_MARCA_REPETE_DIAS = 30;

const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const maior = (a, b) => (a > b ? a : b);
/** 0 = domingo … 6 = sábado. */
const diaDaSemana = (dia) => new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10))).getUTCDay();
const somar = (dia, n) => new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10)) + n * 86_400_000)
  .toISOString().slice(0, 10);

/**
 * O domingo que abre o ciclo da rodada de sessões de `dia` (AAAA-MM-DD, São
 * Paulo). O AQUAP roda as sessões da Evo uma vez por ciclo, de domingo a
 * sábado (M5 do PLANO_MODELOS, §2.11); o Prescrev diz na ficha a rodada que
 * valeu (`agenda.rodada.ciclo`).
 */
export const cicloDe = (dia) => somar(dia, -diaDaSemana(dia));

/** De onde vieram as presenças do comportamento: a catraca, todo dia (M5), ou as sessões. */
const pelaCatraca = (ficha) => ficha?.comportamento?.fonte === 'catraca';

/** O limite de ausência quando a ficha não traz o prazo: 10 dias para todos (M0 do PLANO_MODELOS). */
export const AUSENCIA_AVISO_DIAS = 10;
/** Respondeu há menos que isso, em dias de calendário (hoje ou ontem), e a rotina espera. */
export const RESPOSTA_RECENTE_DIAS = 2;
/** Janela em que uma mensagem de situação segura a rotina. */
export const SITUACAO_SEGURA_DIAS = 7;
/** Até quantos dias depois do relatório da reavaliação sai a mensagem do resultado. */
export const RESULTADO_VALE_DIAS = 7;
/**
 * O que decide pela falta ("não veio", "nada agendado") quer a carga de hoje
 * ou de ontem: mais velha, quem veio ou agendou depois dela receberia o
 * lembrete do que já fez.
 */
export const AGENDA_DO_DIA_DIAS = 1;

/**
 * O limite de ausência: o prazo da ficha (v4), senão 10 dias. Até 27/10/2026
 * era max(5, ⌈14 ÷ frequência⌉) — três réguas, que avisavam quem vem 3
 * vezes quando 89% voltariam sozinhos (M0, §1.5 do plano).
 */
export function limiteAusencia(ficha) {
  return ficha?.comportamento?.ausencia?.prazos?.aviso ?? AUSENCIA_AVISO_DIAS;
}

/**
 * O que a régua lê do comportamento da ficha (v4): a fase, o degrau, a
 * cadência e o teto da fase, e a etapa da ausência. null = ficha sem
 * comportamento (sem carga do AQUAP, ou anterior à v4).
 */
export function fasesDaFicha(ficha) {
  const c = ficha?.comportamento;
  if (!c?.fase) return null;
  return {
    fase: c.fase.valor,
    degrau: c.degrau?.valor ?? null,
    cadencia: c.fase.cadencia_dias ?? null,
    teto: { mensagens: c.fase.teto_mensagens, dias: c.fase.teto_dias },
    ausencia: c.ausencia?.etapa ?? 'presente',
    ausenciaDesde: c.ausencia?.desde ?? null,
    ate: c.ate,
    // M2: o que a ativação pede, o lembrete de agendamento e o período habitual.
    ativacao: c.fase.ativacao_etapa ?? null,
    ativacaoDias: c.fase.ativacao_dias ?? null,
    lembreteAgendamento: !!c.fase.lembrete_agendamento,
    periodo: c.periodo_habitual ?? null,
    // A semana do programa: no início, é ela que escolhe a rotina (o que esperar dela).
    semana: c.semana ?? null,
  };
}

/** Os dados da carga servem para decidir pela falta hoje? */
const doDia = (ate, hoje) => !!ate && ate <= hoje && diasEntre(ate, hoje) <= AGENDA_DO_DIA_DIAS;

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
 * Os treinos do EVO (`default-client-workout`), resumidos no que a régua lê.
 * Excluídos saem; data sem hora, como o EVO grava (horário local, sem fuso).
 */
export function resumirTreinos(workouts) {
  return (workouts ?? [])
    .filter(w => w && !w.isDeleted && w.startDate)
    .map(w => ({
      id: w.idWorkout,
      inicio: String(w.startDate).slice(0, 10),
      validade: w.expiryDate ? String(w.expiryDate).slice(0, 10) : null,
      previstas: w.totalSessions ?? null,
      concluidas: w.completedSessions ?? 0,
      ultima_concluida: w.lastCompletedSessionDate ? String(w.lastCompletedSessionDate).slice(0, 10) : null,
      frequencia: w.weeklyFrequency ?? null,
      semanas: w.weeklyQuantity ?? null,
      professor_id: w.idInstructor ?? null,
      professor: w.instructorName ?? null,
    }))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
}

/** O treino em curso: o último que já começou. `vigente` = ainda dentro da validade. */
export function treinoVigente(treinos, hoje) {
  const t = (treinos ?? []).filter(x => x.inicio <= hoje).at(-1);
  return t ? { ...t, vigente: !t.validade || t.validade >= hoje } : null;
}

/** Os ids da Musculação na agenda do EVO, se ela está no programa. */
function idsDaMusculacao(ficha) {
  return (ficha.modalidades ?? []).find(m => m.slug === 'musculacao')?.atividades_evo ?? [];
}

/**
 * O ciclo em curso: o último treino do EVO criado depois da entrega do
 * relatório, o ciclo da ficha na mesma posição, e as presenças de
 * Musculação na agenda desde o início dele. Sem treino do programa, o motivo.
 */
export function cicloDoTreino(ficha, treinos, agenda, hoje) {
  const ids = idsDaMusculacao(ficha);
  if (!ids.length || !(ficha.ciclos ?? []).length || !agenda?.inicio) return null;
  const doPrograma = (treinos ?? []).filter(x => x.inicio >= agenda.inicio && x.inicio <= hoje);
  if (!doPrograma.length) {
    const vig = treinoVigente(treinos, hoje);
    return {
      treino: null,
      nota: vig ? `Treino de musculação no EVO de ${ddmm(vig.inicio)}, anterior ao programa: o ciclo se confere no treino novo.`
        : 'Sem treino de musculação no EVO.',
    };
  }
  const treino = doPrograma.at(-1);
  const ciclo = ficha.ciclos[Math.min(doPrograma.length - 1, ficha.ciclos.length - 1)];
  const presencas = agenda.presentes.filter(x => ids.includes(x.atividade_evo) && x.dia >= treino.inicio).length;
  return { treino, ciclo, numero: doPrograma.length, presencas };
}

/**
 * Os modelos candidatos de uma situação para uma trilha, em CAMADAS: a
 * primeira que tiver um modelo que se preencha decide, e o rodízio é dentro
 * de cada camada. Rotina é sempre da trilha; nas outras, o modelo da trilha
 * vem antes do de 'todas'.
 *
 * Na rotina, com o comportamento da ficha, um modelo diz onde vale por três
 * campos, cada um opcional: `semanas` (as semanas do início, de–até),
 * `fase` e `degrau`. Vale o que casa em todos os que diz, e o mais
 * específico vem antes — semana, depois fase, depois degrau: no início, o
 * que esperar da semana; depois, na adesão, o da fase, e nas outras trilhas
 * o do degrau; no retorno, o N1 da fase. Sem nenhum que case, os genéricos
 * — os de `degrau`, `fase` e `semanas` nulos, os da tela Modelos. O genérico
 * não entra atrás dos outros: o assunto de um não é o do outro.
 */
export function camadasDe(modelos, situacao, trilha, { fase = null, degrau = null, semana = null } = {}) {
  const da = modelos.filter(m => m.situacao === situacao && m.trilha === trilha);
  if (situacao === 'rotina') {
    const generico = (m) => m.degrau == null && m.fase == null && m.semanas == null;
    if (degrau !== null) {
      const vale = (m) => !generico(m)
        && (m.degrau == null || m.degrau === degrau)
        && (m.fase == null || m.fase === fase)
        && (m.semanas == null || (semana !== null && semana >= m.semanas[0] && semana <= m.semanas[1]));
      const peso = (m) => (m.semanas ? 4 : 0) + (m.fase ? 2 : 0) + (m.degrau != null ? 1 : 0);
      const porPeso = new Map();
      for (const m of da.filter(vale)) porPeso.set(peso(m), [...(porPeso.get(peso(m)) ?? []), m]);
      const camadas = [...porPeso.entries()].sort((a, b) => b[0] - a[0]).map(([, c]) => c);
      if (camadas.length) return camadas;
    }
    return [da.filter(generico)];
  }
  if (da.length) return [da];
  return [modelos.filter(m => m.situacao === situacao && m.trilha === 'todas')];
}

/** Os candidatos em uma lista só, na ordem das camadas. */
export function candidatosDe(modelos, situacao, trilha, onde = {}) {
  return camadasDe(modelos, situacao, trilha, onde).flat();
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
  const limite = limiteAusencia(ficha);
  const inicio = ficha.relatorio_aluno?.entregue_em ? diaSP(ficha.relatorio_aluno.entregue_em) : null;
  const ultimoAviso = [...anteriores].reverse().find(h => h.situacao === 'ausencia')?.dia ?? '';
  const aviso = sinais
    .filter(x => x.dia > ultimoAviso && (!inicio || x.dia >= inicio)
      && diasEntre(x.dia, hoje) <= AVISO_AUSENCIA_VALE_DIAS && (x.dias === null || x.dias >= limite))
    .sort((a, b) => a.dia.localeCompare(b.dia)).at(-1);
  if (!aviso) return null;

  // A catraca confere (M5): entrada depois do começo do período que o EVO
  // diz vazio. É a mesma fonte do aviso, e todo dia.
  if (pelaCatraca(ficha) && aviso.dias) {
    const de = somar(aviso.dia, -aviso.dias + 1);
    const ultima = ficha.comportamento.presencas?.ultima ?? null;
    if (ultima && ultima >= de) {
      return { situacao: null, motivo: `Aviso "Sem presença" do EVO de ${ddmm(aviso.dia)} contradito pela catraca (entrada em ${ddmm(ultima)}): não sai.` };
    }
  }
  // A avaliação confere (M6, FASES_VERSION 3 do Prescrev): a catraca não
  // registra a ida à avaliação, e "uma pausa nos seus treinos" saía dois dias
  // depois de a pessoa ser avaliada. Sem o número de dias do EVO, vale o limite.
  const avaliada = ficha.comportamento?.presencas?.avaliacao ?? null;
  if (avaliada && avaliada <= aviso.dia
    && (aviso.dias ? avaliada >= somar(aviso.dia, -aviso.dias + 1) : diasEntre(avaliada, aviso.dia) < limite)) {
    return { situacao: null, motivo: `Aviso "Sem presença" do EVO de ${ddmm(aviso.dia)} contradito pela avaliação em ${ddmm(avaliada)}: não sai.` };
  }
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
      `; limite de ${limite} dias.${d6}`,
  };
}

/**
 * A porta aberta (§2.5 do PLANO_MODELOS): aos 30 dias sem vir (60 no aluno
 * ativo) a ficha diz `porta_aberta`, e sai a última mensagem — uma por
 * ausência, contada da última presença. Depois dela, silêncio até a
 * próxima presença. O modelo entra na M2; sem ele, a situação é pulada e a
 * rotina continua calada pelo freio.
 */
function portaAberta({ fases, anteriores }) {
  if (fases?.ausencia !== 'porta_aberta') return null;
  const desde = fases.ausenciaDesde ?? '';
  if (anteriores.some(h => h.situacao === 'porta_aberta' && h.dia >= desde)) return null;
  return {
    situacao: 'porta_aberta', valores: {},
    motivo: `Porta aberta: sem vir desde ${desde ? ddmm(desde) : '—'} (dados de ${ddmm(fases.ate)}). ` +
      'A última mensagem; depois, silêncio até a próxima presença.',
  };
}

/** O teto da fase alcançado na janela dela — o motivo, ou null. */
function tetoAlcancado({ fases, anteriores, hoje }) {
  if (!fases) return null;
  const janela = somar(hoje, -(fases.teto.dias - 1));
  const n = anteriores.filter(h => h.dia >= janela).length;
  return n >= fases.teto.mensagens ? `teto da fase ${fases.fase} alcançado (${n} em ${fases.teto.dias} dias).` : null;
}

/** Por que a rotina devida não sai hoje — ou null, se sai. */
function freioDaRotina({ fases, anteriores, hoje, ultimaResposta }) {
  if (fases && (fases.ausencia === 'silencio' || fases.ausencia === 'porta_aberta')) {
    return `ausência em ${fases.ausencia === 'silencio' ? 'silêncio' : 'porta aberta'} (dados de ${ddmm(fases.ate)}), nada ao aluno até a próxima presença.`;
  }
  if (ultimaResposta && diasEntre(ultimaResposta, hoje) < RESPOSTA_RECENTE_DIAS) {
    return `o aluno respondeu em ${ddmm(ultimaResposta)}, e a rotina espera 48 h.`;
  }
  const semana = somar(hoje, -(SITUACAO_SEGURA_DIAS - 1));
  const situacao = anteriores.find(h => h.situacao !== 'rotina' && h.dia >= semana);
  if (situacao) return `já saiu ${situacao.situacao} em ${ddmm(situacao.dia)}, e uma situação na semana segura a rotina.`;
  return tetoAlcancado({ fases, anteriores, hoje });
}

/**
 * Por que um empurrão (primeira ida, lembrete de agendamento) não sai hoje.
 * Não é evento: não sai no dia seguinte a outra mensagem, e conta no teto
 * da fase como a rotina. A situação de evento passa na frente; o empurrão,
 * não.
 */
function freioDoEmpurrao({ fases, anteriores, hoje }) {
  const ontem = somar(hoje, -1);
  const recente = [...anteriores].reverse().find(h => h.dia >= ontem);
  if (recente) return `já saiu ${recente.situacao} em ${ddmm(recente.dia)}, e o lembrete não sai no dia seguinte a outra mensagem.`;
  return tetoAlcancado({ fases, anteriores, hoje });
}

/**
 * A primeira ida (§2.2, M2): na ativação, a ficha diz 'lembrete' do 3º ao
 * 6º dia aberto sem ida. Uma por entrega do relatório. Com a carga velha,
 * espera: quem veio depois dela receberia o lembrete do primeiro treino.
 */
function primeiraIda({ ficha, fases, anteriores, hoje }) {
  if (fases?.fase !== 'ativacao' || fases.ativacao !== 'lembrete') return null;
  const entrega = ficha.relatorio_aluno?.entregue_em ? diaSP(ficha.relatorio_aluno.entregue_em) : '';
  if (anteriores.some(h => h.situacao === 'primeira_ida' && h.dia >= entrega)) return null;
  if (!doDia(fases.ate, hoje)) {
    return { situacao: null, motivo: `Lembrete da primeira ida devido, e os dados são de ${ddmm(fases.ate)}: espera a carga do dia.` };
  }
  return {
    situacao: 'primeira_ida', valores: {}, empurrao: true,
    motivo: `${fases.ativacaoDias} dia(s) desde a entrega do relatório sem presença na agenda (dados de ${ddmm(fases.ate)}): o lembrete da primeira ida.`,
  };
}

/** O período seguinte ao habitual: é nele que o lembrete sai. */
const DEPOIS_DO_PERIODO = { 'manhã': 'tarde', tarde: 'noite', noite: 'manhã' };

/**
 * O lembrete de agendamento (decisão 2): nas 3 primeiras semanas do início,
 * com nada agendado na semana, na terça depois do período em que a pessoa
 * mais treina — e na quarta de manhã para quem treina à noite. O período é
 * o habitual das presenças; sem ele, o declarado; sem nenhum, manhã.
 *
 * "Nada agendado" é a semana inteira, de segunda a domingo, e não só a
 * segunda e a terça: quem já tem a quinta marcada leria "já agendou os
 * treinos desta semana?" como quem não olhou a agenda.
 *
 * Quer a agenda carregada HOJE. As pessoas agendam em cima da hora: com a
 * carga de ontem, a terça de quem agendou na segunda à noite não aparece. O
 * que sobra — quem agenda no próprio dia, depois da carga — é o que a M6
 * mede no ensaio.
 */
function lembreteAgendamento({ ficha, fases, anteriores, hoje }) {
  if (!fases?.lembreteAgendamento) return null;
  if (pelaCatraca(ficha)) return lembretePelaCatraca({ ficha, fases, anteriores, hoje });
  const periodo = fases.periodo ?? ficha.marcadores?.periodo ?? 'manhã';
  const dia = periodo === 'noite' ? 3 : 2;
  if (diaDaSemana(hoje) !== dia) return null;
  const segunda = somar(hoje, -(dia - 1));
  if (anteriores.some(h => h.situacao === 'lembrete_agendamento' && h.dia >= segunda)) return null;
  const carga = ficha.agenda?.sincronizada_em ? diaSP(ficha.agenda.sincronizada_em) : null;
  if (!carga || carga < hoje) {
    return {
      situacao: null,
      motivo: `Lembrete de agendamento devido, e a agenda é de ${carga ? ddmm(carga) : '—'}: espera a agenda do dia (sync diário, M5).`,
    };
  }
  const domingo = somar(segunda, 6);
  if ((ficha.agenda.sessoes ?? []).some(s => s.dia >= segunda && s.dia <= domingo)) return null;
  const envio = DEPOIS_DO_PERIODO[periodo] ?? 'tarde';
  return {
    situacao: 'lembrete_agendamento', valores: {}, empurrao: true, periodo_envio: envio,
    motivo: `Semana ${ficha.comportamento?.semana ?? '?'} do início, nada agendado de ${ddmm(segunda)} a ${ddmm(domingo)} ` +
      `(agenda de ${ddmm(carga)}). Treina de ${periodo}: o lembrete sai ${dia === 3 ? 'na quarta' : 'na terça'}, de ${envio}.`,
  };
}

/**
 * O lembrete de agendamento pela CATRACA (decisão 17, 28/10/2026, M5): nas 3
 * primeiras semanas do início, quem não passou pela catraca na segunda nem na
 * terça. A catraca chega todo dia à 01:00 com o dia anterior completo: a
 * terça só se conhece na quarta. Por isso o lembrete sai na QUARTA, no período
 * seguinte ao habitual (de manhã para quem treina à noite).
 *
 * A pergunta ("já agendou os treinos dessa semana?") não afirma nada, e serve
 * a quem não veio sem saber se agendou.
 */
function lembretePelaCatraca({ ficha, fases, anteriores, hoje }) {
  if (diaDaSemana(hoje) !== 3) return null;
  const segunda = somar(hoje, -2), terca = somar(hoje, -1);
  if (anteriores.some(h => h.situacao === 'lembrete_agendamento' && h.dia >= segunda)) return null;
  const ate = ficha.comportamento.ate;
  if (!ate || ate < terca) {
    return { situacao: null, motivo: `Lembrete de agendamento devido, e a catraca é de ${ate ? ddmm(ate) : '—'}: espera a terça completa.` };
  }
  const ultima = ficha.comportamento.presencas?.ultima ?? null;
  if (ultima && ultima >= segunda) return null;
  const periodo = fases.periodo ?? ficha.marcadores?.periodo ?? 'manhã';
  const envio = DEPOIS_DO_PERIODO[periodo] ?? 'tarde';
  return {
    situacao: 'lembrete_agendamento', valores: {}, empurrao: true, periodo_envio: envio,
    motivo: `Semana ${ficha.comportamento.semana ?? '?'} do início, sem entrada na catraca na segunda (${ddmm(segunda)}) nem na ` +
      `terça (${ddmm(terca)}). Treina de ${periodo}: o lembrete sai hoje, de ${envio}.`,
  };
}

/** O resultado da reavaliação (decisão 9): o relatório gerado, até 7 dias depois; uma vez por reavaliação. */
function resultadoReavaliacao({ ficha, anteriores, hoje }) {
  const pronta = ficha.reavaliacao_pronta_em;
  if (!pronta || pronta > hoje || diasEntre(pronta, hoje) > RESULTADO_VALE_DIAS) return null;
  if (anteriores.some(h => h.situacao === 'resultado_reavaliacao' && h.dia >= pronta)) return null;
  return {
    situacao: 'resultado_reavaliacao', valores: {},
    motivo: `Relatório da reavaliação gerado em ${ddmm(pronta)}: o convite para ver o resultado com o professor, sem número (decisão 9).`,
  };
}

function retorno({ ficha, anteriores, agenda }) {
  const aviso = [...anteriores].reverse().find(h => h.situacao === 'ausencia');
  if (!aviso || anteriores.some(h => h.situacao === 'retorno' && h.dia > aviso.dia)) return null;
  // Pela catraca (M5): a volta é o dia em que a régua das fases viu o retorno,
  // ou a última entrada depois do aviso. A catraca não diz a atividade: sai o
  // modelo sem {atividade_retorno}.
  if (pelaCatraca(ficha)) {
    const c = ficha.comportamento;
    const dia = [c.fase?.retornou_em, c.presencas?.ultima].find(d => d && d > aviso.dia);
    if (!dia) return null;
    return {
      situacao: 'retorno',
      valores: { dia_retorno: diaPorExtenso(dia), atividade_retorno: null },
      motivo: `Entrada na catraca em ${ddmm(dia)}, depois do aviso de ausência de ${ddmm(aviso.dia)} (catraca até ${ddmm(c.ate)}).`,
    };
  }
  if (!agenda) return null;
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
    // `modalidades_sem_agenda` não é marcador: é a conta do aviso ao professor.
    valores: { modalidade: emLista(faltam.map(m => m.nome)), modalidades_sem_agenda: faltam.length },
    motivo: `Nenhum agendamento na agenda do EVO de ${ddmm(de)} a ${ddmm(agenda.carga)}: ${faltam.map(m => m.nome).join(', ')}.`,
  };
}

function cicloEmRisco({ ciclo, anteriores, hoje }) {
  const { treino, presencas } = ciclo;
  const minimo = ciclo.ciclo?.minimo_treinos;
  if (!minimo || !treino.validade || hoje > treino.validade) return null;
  const meio = somar(treino.inicio, Math.floor(diasEntre(treino.inicio, treino.validade) / 2));
  if (hoje < meio || presencas * 2 >= minimo) return null;
  if (anteriores.some(h => h.situacao === 'ciclo_em_risco' && h.dia >= treino.inicio)) return null;
  return {
    situacao: 'ciclo_em_risco',
    valores: { treinos_ciclo: String(presencas), minimo_ciclo: String(minimo) },
    motivo: `Metade do treino do ${ciclo.numero}º ciclo (${ddmm(treino.inicio)} a ${ddmm(treino.validade)}) com ` +
      `${presencas} de ${minimo} treinos de musculação na agenda.`,
  };
}

function minimoCumprido({ ciclo, anteriores }) {
  const { treino, presencas } = ciclo;
  const minimo = ciclo.ciclo?.minimo_treinos;
  if (!minimo || presencas < minimo) return null;
  if (anteriores.some(h => h.situacao === 'minimo_cumprido' && h.dia >= treino.inicio)) return null;
  return {
    situacao: 'minimo_cumprido',
    valores: { treinos_ciclo: String(presencas), minimo_ciclo: String(minimo) },
    motivo: `${presencas} treinos de musculação na agenda desde ${ddmm(treino.inicio)}: mínimo de ${minimo} do ${ciclo.numero}º ciclo cumprido.`,
  };
}

function naoMarcaApp({ ficha, treinos, anteriores, agenda, hoje }) {
  const ids = idsDaMusculacao(ficha);
  const vig = treinoVigente(treinos, hoje);
  if (!ids.length || !vig) return null;
  const de = somar(agenda.carga, -NAO_MARCA_DIAS);
  const naAgenda = agenda.presentes.filter(x => ids.includes(x.atividade_evo) && x.dia >= de).length;
  if (naAgenda < 2) return null;
  if (vig.ultima_concluida && vig.ultima_concluida >= de) return null;
  if (anteriores.some(h => h.situacao === 'nao_marca_app' && diasEntre(h.dia, hoje) < NAO_MARCA_REPETE_DIAS)) return null;
  return {
    situacao: 'nao_marca_app',
    valores: {},
    motivo: `${naAgenda} treinos de musculação na agenda de ${ddmm(de)} a ${ddmm(agenda.carga)}, e nenhum marcado no app ` +
      (vig.ultima_concluida ? `(último em ${ddmm(vig.ultima_concluida)}).` : '(nenhum no treino vigente).'),
  };
}

/**
 * O que iria à equipe hoje, à parte da mensagem ao aluno. Cada aviso vira um
 * encaminhamento (`encaminhamentos.js`): `codigo` e `referencia` não deixam
 * abrir o mesmo duas vezes — o treino vencendo aparece todo dia por uma
 * semana, e é um encaminhamento só. `motivo` vai na linha "Motivo" do
 * briefing; `texto`, no resumo e na prévia.
 *
 * `conduta` (M3) é o que fazer, com fonte no Prescrev: vai na linha "Conduta"
 * do briefing. `destino` 'consultor' vai ao consultor responsável — até a M5
 * trazer quem ele é, à coordenação.
 *
 * @returns {{ codigo: string, motivo: string, texto: string, urgencia: 'hoje'|'proximos_dias', referencia: string,
 *   conduta?: string, destino?: 'professor'|'consultor' }[]}
 */
export function avisosDaEquipe({ ficha, treinos, ciclo, hoje, situacao, valores = {}, fases = null, condutas = [] }) {
  // A voz ao professor (revisão do responsável, 27/10/2026): assertiva e
  // sempre positiva — o fato em uma frase, e o que fazer, conjugado ("monta",
  // "chama"), com o porquê de ganho. Número e data aqui valem: é a equipe.
  const avisos = [];
  // M2 (§2.2): na ativação, 7 dias abertos sem ida — o contato agora é do
  // professor. Um por entrega (a referência), com a carga de hoje ou de
  // ontem: com a velha, quem veio depois dela seria cobrado à toa. A conduta
  // com fonte entra na M3.
  if (fases?.fase === 'ativacao' && fases.ativacao === 'nunca_veio' && doDia(fases.ate, hoje) && ficha.relatorio_aluno?.entregue_em) {
    const entrega = diaSP(ficha.relatorio_aluno.entregue_em);
    avisos.push({
      codigo: 'nunca_veio', motivo: 'ainda não veio depois da entrega do relatório', urgencia: 'proximos_dias', referencia: entrega,
      texto: `${fases.ativacaoDias} dias desde a entrega do relatório (${ddmm(entrega)}) sem presença na agenda (dados de ` +
        `${ddmm(fases.ate)}). Chama pra combinar o primeiro treino, com dia e hora: quem vem logo no começo tem muito mais chance de ficar.`,
    });
  }
  const vig = treinoVigente(treinos, hoje);
  if (vig?.validade) {
    const faltam = diasEntre(hoje, vig.validade);
    if (faltam >= 0 && faltam <= TREINO_VENCENDO_DIAS) {
      avisos.push({
        codigo: 'treino_vencendo', motivo: 'treino de musculação vencendo', urgencia: 'proximos_dias', referencia: String(vig.id),
        texto: `O treino de musculação vence em ${faltam} dia(s), em ${ddmm(vig.validade)}. Já monta o próximo ciclo: treino novo na hora certa mantém o embalo.`,
      });
    } else if (faltam < 0 && -faltam <= TREINO_VENCIDO_AVISA_DIAS) {
      // O último treino que começou já venceu: ninguém criou o seguinte.
      avisos.push({
        codigo: 'treino_vencido', motivo: 'treino de musculação vencido', urgencia: 'proximos_dias', referencia: String(vig.id),
        texto: `O treino de musculação venceu em ${ddmm(vig.validade)} e o próximo ainda não está no EVO. Monta o novo ciclo e apresenta no próximo treino: novidade puxa a vontade de vir.`,
      });
    }
  }
  if (situacao === 'ciclo_em_risco' && ficha.trilha.principal === 'adesao' && ciclo?.treino) {
    avisos.push({
      codigo: 'ciclo_em_risco', motivo: 'ciclo de musculação em risco', urgencia: 'proximos_dias', referencia: String(ciclo.treino.id),
      texto: `Metade do ciclo de musculação com ${ciclo.presencas} de ${ciclo.ciclo.minimo_treinos} treinos. Puxa uma conversa rápida no próximo treino e combina com ele o que ajustar: o próximo treino na agenda fecha o ciclo.`,
    });
  }
  // D6: na adesão, a ausência sai ao aluno e ao professor ao mesmo tempo.
  if (situacao === 'ausencia' && ficha.trilha.principal === 'adesao') {
    avisos.push({
      codigo: 'ausencia_adesao', motivo: 'ausência na trilha de adesão', urgencia: 'proximos_dias', referencia: hoje,
      texto: `Aviso "Sem presença" do EVO${valores.dias ? `: ${valores.dias} dias sem vir` : ''}. A Leia mandou uma mensagem leve; agora vale o seu contato, com convite pra um dia certo. É o contato do professor que mais traz de volta.`,
    });
  }
  // Modalidade do programa sem agendamento (pedido do responsável,
  // 28/10/2026), em todas as trilhas: o aluno recebe a oferta de ajuda, e o
  // professor dele, o pedido de avisar quem dá a aula. O responsável pela
  // modalidade não está em dado nenhum — o `instructor` das sessões é de
  // quem tem aula marcada, e aqui não há —, por isso o aviso vai a quem já
  // recebe os encaminhamentos do aluno, e ele repassa.
  if (situacao === 'sem_agendamento' && valores.modalidade) {
    const varias = (valores.modalidades_sem_agenda ?? 1) > 1;
    avisos.push({
      codigo: 'sem_agendamento', motivo: varias ? 'modalidades do programa sem agendamento' : 'modalidade do programa sem agendamento',
      urgencia: 'proximos_dias', referencia: hoje,
      texto: `${valores.modalidade} ${varias ? 'estão' : 'está'} no programa e sem nenhum agendamento na agenda do EVO nas últimas ` +
        `${SEM_AGENDAMENTO_DIAS / 7} semanas. A Leia já ofereceu ajuda pra achar um horário. Avisa ` +
        `${varias ? 'os professores responsáveis pelas modalidades' : 'o professor responsável pela modalidade'}: ` +
        'o convite de quem dá a aula deixa a primeira ida bem mais fácil.',
    });
  }
  // M3 (§2.8): as condutas ao professor. O Prescrev diz na ficha quais valem
  // hoje (`ficha.condutas`, código e referência) e publica o texto com os
  // modelos (`condutas`); aqui só se lê. Um encaminhamento por (código,
  // referência): a ficha traz a de semana 1 a semana inteira, e ela sai uma
  // vez. A de ausência quer a carga de hoje ou de ontem (`carga_do_dia`):
  // falta velha não é fato. Sem o catálogo (Prescrev de antes da M3), nada.
  const porCodigo = new Map((condutas ?? []).map(c => [c.codigo, c]));
  const comConduta = (cat) => {
    if (!cat) return null;
    const nome = ficha.marcadores?.nome ?? ficha.aluno?.primeiro_nome ?? null;
    return preencher(cat.texto, { nome, dias: ficha.comportamento?.dias_sem_vir ?? null }).texto;
  };
  for (const ativa of ficha.condutas ?? []) {
    const cat = porCodigo.get(ativa.codigo);
    if (!cat || cat.gatilho !== 'ficha') continue;
    if (cat.carga_do_dia && !doDia(ficha.comportamento?.ate, hoje)) continue;
    const texto = comConduta(cat);
    if (!texto) continue;
    avisos.push({
      codigo: cat.codigo, motivo: cat.sinal, urgencia: 'proximos_dias', referencia: ativa.referencia,
      texto, conduta: texto, destino: cat.destino,
    });
  }
  // A conduta que vai junto de um aviso que a régua já dava (gatilho 'regua').
  for (const aviso of avisos) {
    const cat = porCodigo.get(aviso.codigo);
    if (cat?.gatilho === 'regua' && !aviso.conduta) {
      const texto = comConduta(cat);
      if (texto) aviso.conduta = texto;
    }
  }
  return avisos;
}

const NOME_DO_EMPURRAO = { primeira_ida: 'Lembrete da primeira ida', lembrete_agendamento: 'Lembrete de agendamento' };

/** A situação devida hoje, ou o motivo de nada estar devido. */
export function situacaoDoDia({
  ficha, anteriores, sinais = [], treinos = [], hoje, modo, modelos = null, ativadoEm = null, ultimaResposta = null,
  verificaAtividade = true,
}) {
  if (!anteriores.length) {
    if (modo === 'ensaio') {
      return { situacao: 'boas_vindas', valores: {}, motivo: 'Primeira mensagem. No envio real, sai no dia seguinte à ativação pelo código.' };
    }
    // O aceite sai na hora do ATIVAR; a boas-vindas da trilha, no dia
    // seguinte (decisão do responsável em 08/10/2026).
    if (!ativadoEm) return { situacao: null, motivo: 'Aguardando a ativação pelo código.' };
    if (ativadoEm >= hoje) return { situacao: null, motivo: 'Ativou hoje: a boas-vindas da trilha sai amanhã.' };
    return { situacao: 'boas_vindas', valores: {}, motivo: `Ativou em ${ddmm(ativadoEm)}: a boas-vindas da trilha, depois do aceite.` };
  }

  const agenda = leituraDaAgenda(ficha);
  const fases = fasesDaFicha(ficha);
  const falta = ausencia({ ficha, anteriores, sinais, agenda, hoje });
  const ciclo = cicloDoTreino(ficha, treinos, agenda, hoje);
  // Com os modelos à mão, situação sem modelo para a trilha é pulada.
  const temModelo = (e) => !modelos || candidatosDe(modelos, e.situacao, ficha.trilha.principal).length > 0;
  // Em silêncio ou porta aberta nada vai ao aluno — fora o retorno (ele
  // voltou, e a agenda o diz) e a própria porta aberta.
  const calada = !!fases && (fases.ausencia === 'silencio' || fases.ausencia === 'porta_aberta');
  // A atividade combinada (o ciclo, a modalidade sem agendamento, o treino
  // no app) se verifica uma vez por rodada de sessões, no primeiro ensaio
  // depois dela (M5, decisão 18): as sessões rodam no domingo, e ficam
  // paradas a semana. Quem decide é o ensaio (`verificaAtividade`).
  const atividade = verificaAtividade;
  const lidos = [
    falta,
    (agenda || pelaCatraca(ficha)) && retorno({ ficha, anteriores, agenda }),
    portaAberta({ fases, anteriores }),
    atividade && ciclo?.treino && cicloEmRisco({ ciclo, anteriores, hoje }),
    resultadoReavaliacao({ ficha, anteriores, hoje }),
    reavaliacao({ ficha, anteriores, hoje }),
    atividade && ciclo?.treino && minimoCumprido({ ciclo, anteriores }),
    primeiraIda({ ficha, fases, anteriores, hoje }),
    lembreteAgendamento({ ficha, fases, anteriores, hoje }),
    atividade && agenda && semAgendamento({ ficha, anteriores, agenda, hoje }),
    atividade && agenda && naoMarcaApp({ ficha, treinos, anteriores, agenda, hoje }),
  ].filter(Boolean);
  // O que estava devido e esperou (aviso contradito, carga velha) vira nota
  // no motivo do dia: "não mandar" também se explica.
  const notas = lidos.filter(e => !e.situacao && e.motivo).map(e => e.motivo);
  const evento = lidos
    .filter(e => e.situacao && (!calada || e.situacao === 'retorno' || e.situacao === 'porta_aberta'))
    .filter(e => {
      if (!e.empurrao) return true;
      const freio = freioDoEmpurrao({ fases, anteriores, hoje });
      if (freio) notas.push(`${NOME_DO_EMPURRAO[e.situacao]} devido, e não sai: ${freio}`);
      return !freio;
    })
    .find(temModelo);
  if (evento) return { ...evento, ciclo, fases };

  const ultimo = anteriores[anteriores.length - 1];
  const desde = diasEntre(ultimo.dia, hoje);
  const nota = notas.map(n => ` ${n}`).join('') + (!agenda ? ' Agenda do EVO ainda não carregada.' : '')
    + (ciclo?.nota ? ` ${ciclo.nota}` : '');
  // A cadência é a da fase (v4); sem comportamento na ficha, a da trilha.
  const cadencia = fases ? fases.cadencia : ficha.trilha.cadencia_dias;
  const daFase = fases ? ` (fase ${fases.fase}, degrau N${fases.degrau ?? '?'})` : '';
  if (cadencia === null) {
    return { situacao: null, ciclo, fases, motivo: `Sem rotina na fase ${fases.fase}: ${ficha.comportamento.fase.motivo}${nota}` };
  }
  if (desde >= cadencia) {
    const freio = freioDaRotina({ fases, anteriores, hoje, ultimaResposta });
    if (freio) {
      return { situacao: null, ciclo, fases, motivo: `Rotina devida (${desde} dia(s), cadência de ${cadencia}${daFase}) e não sai: ${freio}${nota}` };
    }
    return { situacao: 'rotina', valores: {}, ciclo, fases, motivo: `${desde} dia(s) desde a última mensagem; cadência de ${cadencia}${daFase}.` };
  }
  return {
    situacao: null, ciclo, fases,
    motivo: `Próxima rotina em ${cadencia - desde} dia(s): cadência de ${cadencia}${daFase}, última em ${ddmm(ultimo.dia)}.${nota}`,
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
 * @param {object[]} [p.treinos] os treinos de musculação do aluno no EVO,
 *   resumidos por `resumirTreinos`
 * @param {string} p.hoje       'AAAA-MM-DD', em São Paulo
 * @param {'ensaio'|'envio'} p.modo
 * @returns {{ status: 'simulado'|'pendente'|'bloqueado'|'nada', situacao: string|null, trilha: string,
 *   modelo_id: string|null, texto: string|null, valores: object, motivo: string, bloqueios: string[],
 *   avisos_equipe: object[] }} — ver `avisosDaEquipe`
 */
/** Quantas mensagens seguidas sem resposta e sem presença param a rotina (§5.4). */
export const FREIO_SEM_RESPOSTA = 3;

/**
 * @param {object} p
 * @param {{ status: string, ativadoEm: string, pausadoAte: string|null } | null} [p.inscricao]
 *   a inscrição do aluno no WhatsApp (A5). No envio real, sem ela nada sai; no
 *   ensaio, `null` explícito anota no motivo que no envio real não sairia.
 * @param {number} [p.semResposta]  mensagens seguidas sem resposta e sem presença
 * @param {string|null} [p.ultimaResposta]  o dia ('AAAA-MM-DD', em São Paulo) da última
 *   mensagem do aluno; hoje ou ontem, a rotina espera
 */
export function decidir({
  ficha, modelos, condutas = [], historico, sinais = [], treinos = [], hoje, modo, inscricao, semResposta = 0, ultimaResposta = null,
  verificaAtividade = true,
}) {
  const trilha = ficha.trilha.principal;
  const fasesLidas = fasesDaFicha(ficha);
  const base = {
    trilha, fase: fasesLidas?.fase ?? null, degrau: fasesLidas?.degrau ?? null,
    situacao: null, modelo_id: null, texto: null, valores: {}, bloqueios: [], avisos_equipe: [],
  };

  if (ficha.estado?.encerrado) {
    return { ...base, status: 'nada', motivo: 'Acompanhamento encerrado no Prescrev.' };
  }
  if (ficha.estado?.pausado_ate && ficha.estado.pausado_ate >= hoje) {
    return { ...base, status: 'nada', motivo: `Pausado até ${ddmm(ficha.estado.pausado_ate)}.` };
  }
  if (modo === 'envio') {
    if (!inscricao) return { ...base, status: 'nada', motivo: 'O aluno não ativou o WhatsApp.' };
    if (inscricao.status === 'pausada' && (!inscricao.pausadoAte || inscricao.pausadoAte >= hoje)) {
      return { ...base, status: 'nada', motivo: `Pausado pelo aluno${inscricao.pausadoAte ? ` até ${ddmm(inscricao.pausadoAte)}` : ''}.` };
    }
  }

  // Só o que veio antes de hoje: rodar o ensaio duas vezes no mesmo dia
  // não pode fazer o relógio andar duas vezes.
  const anteriores = historico.filter(h => h.dia < hoje).sort((a, b) => a.dia.localeCompare(b.dia));
  const { situacao, motivo: motivoDoDia, valores: valoresDoDia, ciclo, fases, periodo_envio: periodoEnvio = null } = situacaoDoDia({
    ficha, anteriores, sinais, treinos, hoje, modo, modelos, ativadoEm: inscricao?.ativadoEm ?? null, ultimaResposta,
    verificaAtividade,
  });
  const motivo = modo === 'ensaio' && inscricao === null && situacao
    ? `${motivoDoDia} No envio real não sairia: o aluno ainda não ativou o WhatsApp.`
    : motivoDoDia;
  base.avisos_equipe = avisosDaEquipe({ ficha, treinos, ciclo, hoje, situacao, valores: valoresDoDia ?? {}, fases: fases ?? fasesLidas, condutas });
  if (!situacao) return { ...base, status: 'nada', motivo };

  // Freio (§5.4): três mensagens seguidas sem resposta e sem presença — a
  // rotina para. Insistir com quem não responde nem aparece é cobrança. Na
  // adesão o contato passa ao professor; nas outras trilhas, pausa.
  if (modo === 'envio' && situacao === 'rotina' && semResposta >= FREIO_SEM_RESPOSTA) {
    const naAdesao = trilha === 'adesao';
    const ultimo = anteriores[anteriores.length - 1]?.dia ?? hoje;
    return {
      ...base, status: 'nada', freio: naAdesao ? 'aviso' : 'pausa',
      motivo: `${semResposta} mensagens seguidas sem resposta e sem presença: a rotina para. ` +
        (naAdesao ? 'Na adesão, o professor é avisado.' : 'O acompanhamento pausa.'),
      avisos_equipe: naAdesao
        ? [...base.avisos_equipe, {
          codigo: 'tres_sem_resposta', motivo: 'mensagens sem resposta', urgencia: 'proximos_dias', referencia: ultimo,
          texto: `${semResposta} mensagens seguidas sem resposta nem presença, e a Leia pausou a rotina. Agora é com você: um contato pessoal e leve costuma destravar.`,
        }]
        : base.avisos_equipe,
    };
  }

  const valores = { ...valoresDaFicha(ficha, hoje), ...valoresDoDia };
  // D3: sem professor escolhido no card, quem prescreveu o treino vigente no EVO.
  const vig = treinoVigente(treinos, hoje);
  if (ficha.professor?.origem !== 'card' && vig?.professor) valores.professor = primeiroNome(vig.professor) || valores.professor;
  const ultimoId = [...anteriores].reverse().find(h => h.situacao === situacao)?.modelo_id ?? null;
  // O rodízio é dentro de cada camada: a do degrau não começa pelo genérico.
  const candidatos = camadasDe(modelos, situacao, trilha,
    { fase: fases?.fase ?? null, degrau: fases?.degrau ?? null, semana: fases?.semana ?? null })
    .flatMap(c => emRodizio(c, ultimoId));

  const faltam = new Set();
  for (const m of candidatos) {
    // 'nao' = marcador que nada preenche: fica para o professor mandar à mão.
    if (m.envio === 'nao') continue;
    const r = preencher(m.texto, valores);
    if (r.texto) {
      return {
        ...base, situacao, modelo_id: m.id, texto: r.texto, valores,
        status: modo === 'ensaio' ? 'simulado' : 'pendente', motivo,
        // O lembrete de agendamento sai no período seguinte ao habitual (decisão 2).
        ...(periodoEnvio ? { periodo_envio: periodoEnvio } : {}),
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
 * mensagens não saírem todas no mesmo minuto. `periodo` passa por cima do
 * preferido: o lembrete de agendamento sai DEPOIS do período em que a
 * pessoa treina (decisão 2).
 */
export function horaPrevista(ficha, hoje, janela, periodo = null) {
  const base = INICIO_DO_PERIODO[periodo ?? ficha.marcadores?.periodo] ?? 10 * 60;
  let h = 0;
  for (const c of ficha.cliente_id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const minuto = Math.min(Math.max(base, janela.inicioMin) + (h % 41), janela.fimMin - 15);
  const [a, m, d] = hoje.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 0, minuto) - OFFSET_SP_MS);
}
