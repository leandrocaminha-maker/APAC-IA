/**
 * src/services/acompanhamento/conversa.js
 * A conversa da Leia com o aluno do acompanhamento (etapa A3). PURO.
 *
 * Três coisas, todas lidas a cada turno e nenhuma gravada à parte:
 *
 *   - em que troca a conversa está (o limite de três é do responsável,
 *     08/10/2026: o aluno se empolga, e o papo é com o professor);
 *   - o resumo do aluno que vai no contexto — curto, o necessário para
 *     responder sem improvisar;
 *   - os comandos do aluno que não passam pela Leia.
 *
 * ## Quem falou o quê
 *
 *   bot:acompanhamento         a mensagem da régua (abre a rodada; conta no
 *                              teto do número, limite-envio.js)
 *   bot:acompanhamento:aceite  o aceite do ATIVAR (abre a rodada; é resposta,
 *                              e não conta no teto)
 *   bot:acompanhamento:leia    a resposta da Leia nesta conversa
 *
 * Uma troca é uma mensagem do aluno e a resposta da Leia. A contagem
 * recomeça a cada mensagem da régua.
 */
import { leituraDaAgenda } from './regua.js';
import { primeiroNome } from './render.js';
import { LIMITE_DE_TROCAS, SEM_RESPOSTA } from './prompt.js';
import { quandoFicaSabendo } from './ponte-regras.js';

export const SENT_BY_REGUA = 'bot:acompanhamento';
export const SENT_BY_ACEITE = 'bot:acompanhamento:aceite';
/** O que abre uma rodada de trocas: a mensagem da régua e o aceite. */
export const ABRE_RODADA = [SENT_BY_REGUA, SENT_BY_ACEITE];
export const SENT_BY_LEIA = 'bot:acompanhamento:leia';

const TRILHA = { adesao: 'adesão', motivacional: 'motivacional', tecnico: 'técnico', desafiador: 'desafiador' };
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DIA_MS = 86_400_000;
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const somar = (dia, n) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
const diaDaSemana = (dia) => SEMANA[new Date(`${dia}T12:00:00Z`).getUTCDay()];

/**
 * A troca atual. `mensagens` em ordem, com `direction` e `sent_by`.
 * @returns {{ troca: number, respondidas: number, limiteAtingido: boolean }}
 */
export function trocaAtual(mensagens) {
  const lista = mensagens ?? [];
  let inicio = -1;
  lista.forEach((m, i) => { if (m.direction === 'outbound' && ABRE_RODADA.includes(m.sent_by)) inicio = i; });
  const respondidas = lista.slice(inicio + 1).filter(m => m.direction === 'outbound' && m.sent_by === SENT_BY_LEIA).length;
  return { troca: respondidas + 1, respondidas, limiteAtingido: respondidas >= LIMITE_DE_TROCAS };
}

/** "Musculação 4, Mat Pilates 2" — as presenças dos últimos `dias`, por modalidade. */
export function presencasRecentes(ficha, hoje, dias = 14) {
  const leitura = leituraDaAgenda(ficha);
  if (!leitura) return null;
  const desde = somar(hoje, -dias);
  const porModalidade = new Map();
  for (const s of leitura.presentes.filter(s => s.dia > desde && s.dia <= hoje)) {
    const nome = s.modalidade ?? s.atividade_evo ?? 'outra';
    porModalidade.set(nome, (porModalidade.get(nome) ?? 0) + 1);
  }
  const total = [...porModalidade.values()].reduce((a, b) => a + b, 0);
  return { total, texto: [...porModalidade].map(([n, q]) => `${n} ${q}`).join(', ') };
}

/** As próximas sessões agendadas (até 5, em 7 dias): "qui 09/10 07:00 Mat Pilates". */
export function proximasSessoes(ficha, hoje) {
  const ate = somar(hoje, 7);
  return (ficha.agenda?.sessoes ?? [])
    .filter(s => s.dia >= hoje && s.dia <= ate && !s.finalizada && !s.falta)
    .sort((a, b) => (a.dia + (a.hora ?? '')).localeCompare(b.dia + (b.hora ?? '')))
    .slice(0, 5)
    .map(s => `${diaDaSemana(s.dia)} ${ddmm(s.dia)}${s.hora ? ` ${s.hora.slice(0, 5)}` : ''} ${s.modalidade ?? s.atividade_evo ?? ''}`.trim());
}

/**
 * O bloco "O ALUNO" e "A CONVERSA" do contexto. Curto de propósito: o que a
 * Leia precisa para responder, e nada do que ela não pode dizer além do
 * nome da trilha (que decide o tom, e o prompt proíbe dizer).
 */
/** A situação do professor hoje (`professorHoje` de horario.js), numa linha do contexto. */
export function textoDoProfessorHoje(situacao) {
  if (situacao === undefined) return '';
  if (situacao === null) return ' — sem horário cadastrado: quem recebe o encaminhamento é a equipe';
  if (situacao.estado === 'agora') return ` — trabalhando agora, até ${situacao.ate}`;
  if (situacao.estado === 'mais_tarde') return ` — chega hoje às ${situacao.as}`;
  const quando = situacao.volta === 'amanhã' ? 'amanhã'
    : `${['sábado', 'domingo'].includes(situacao.volta) ? 'no' : 'na'} ${situacao.volta}`;
  return ` — não trabalha mais hoje; volta ${quando} às ${situacao.as}`;
}

/**
 * `ponte` (A5d): um professor está conversando com o aluno pelo número da
 * academia, e a mensagem espera o turno dele. A Leia só diz quando ele vê.
 */
export function contextoDoAluno({
  ficha, hoje, troca, ultimaDoAcompanhamento = null, encaminhamentoAberto = null, simulacao = false, situacaoDoProfessor,
  ponte = null,
}) {
  const a = ficha.aluno ?? {};
  const professor = primeiroNome(ficha.marcadores?.professor ?? ficha.professor?.nome ?? '');
  const freq = ficha.frequencia?.dias_semana;
  const modalidades = (ficha.modalidades ?? []).map(m => m.nome).join(', ');
  const t = ficha.trilha ?? {};
  const presencas = presencasRecentes(ficha, hoje);
  const proximas = proximasSessoes(ficha, hoje);
  const reav = ficha.proxima_avaliacao && ficha.proxima_avaliacao >= hoje ? ficha.proxima_avaliacao : null;

  const linhas = [
    '## O ALUNO',
    `- Nome: ${a.primeiro_nome ?? 'não informado'}${a.idade ? `, ${a.idade} anos` : ''}`,
    `- Professor: ${professor ? `${professor}${textoDoProfessorHoje(situacaoDoProfessor)}` : 'não definido — fale da "equipe", sem nome'}`,
    `- Combinado: ${[freq ? `${freq}× por semana` : null, modalidades || null].filter(Boolean).join(' — ') || 'não informado'}`,
    `- Trilha (decide o tom; nunca diga o nome): ${TRILHA[t.principal] ?? 'não informada'}${t.secundaria ? ` (2ª: ${TRILHA[t.secundaria]})` : ''}`,
    `- Próxima reavaliação: ${reav ? `${ddmm(reav)}/${reav.slice(0, 4)}` : 'sem data marcada'}`,
    `- Presenças nos últimos 14 dias: ${presencas ? (presencas.total ? `${presencas.total} (${presencas.texto})` : 'nenhuma') : 'sem agenda carregada — não afirme presença nem falta'}`,
    proximas.length ? `- Agendado nos próximos 7 dias: ${proximas.join('; ')}` : null,
    encaminhamentoAberto
      ? `- Já encaminhado ao professor: ${encaminhamentoAberto.motivo} (${encaminhamentoAberto.quando}) — não abra outro pelo mesmo motivo`
      : null,
    '',
    '## A CONVERSA',
    ponte
      ? `- ${ponte.professor} está conversando com o aluno por aqui, e esta mensagem já foi repassada a ${ponte.professor}, ` +
        `que vê ${quandoFicaSabendo(ponte.situacao)}. Diga isso ao aluno numa linha, sem entrar no assunto e sem ` +
        `encaminhar de novo. Se você já disse isso depois da última mensagem de ${ponte.professor}, responda ` +
        `${SEM_RESPOSTA}. Sinal de alerta continua com você.`
      : null,
    // O histórico começa na fala do aluno: a mensagem que abriu a rodada
    // pode ter ficado de fora dele, e é a ela que ele responde.
    ultimaDoAcompanhamento
      ? `- A mensagem do acompanhamento que ele respondeu (${ultimaDoAcompanhamento.quando}): «${ultimaDoAcompanhamento.texto}»`
      : null,
    // Com a ponte, quem conversa é o professor: a contagem de trocas não se aplica.
    ponte ? null
    : troca.limiteAtingido
      ? `- Limite de trocas atingido (${troca.respondidas} respondidas): só o que precisa de resposta — veja "Até três trocas".`
      : troca.troca === LIMITE_DE_TROCAS
        ? `- Esta é a troca ${troca.troca} de ${LIMITE_DE_TROCAS}, a última: responda e dê o encaminhamento ao professor.`
        : `- Esta é a troca ${troca.troca} de ${LIMITE_DE_TROCAS}: converse normalmente; o encaminhamento pelo limite é só na ${LIMITE_DE_TROCAS}ª.`,
    simulacao ? '- Simulação do painel: as ferramentas registram, e nada é enviado a ninguém.' : null,
  ];
  return linhas.filter(l => l !== null).join('\n');
}

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** A resposta fixa ao "PAUSAR ACOMPANHAMENTO": comando não passa pela Leia. */
export const TEXTO_PAUSA = 'Combinado: pausei as mensagens do acompanhamento. Quando quiser voltar a receber, é só avisar por aqui. ' +
  'E o seu professor continua à disposição na academia.';

/** "PAUSAR ACOMPANHAMENTO", com caixa, acento e pontuação à vontade — e nada mais na mensagem. */
export function ehPedidoDePausa(texto) {
  return normalizar(texto) === 'pausar acompanhamento';
}
