/**
 * scripts/bateria-acompanhamento.js
 * A bateria da Leia no acompanhamento (etapa A3, §10 do plano do Prescrev).
 *
 *   node --env-file=.env scripts/bateria-acompanhamento.js [caso ...]
 *
 * Roda cada caso contra o modelo de verdade, pelo mesmo caminho do simulador
 * (`processarAcompanhamento`), com um aluno FICTÍCIO e em memória: nenhuma
 * conversa é gravada, e as ferramentas só registram. Grava só a telemetria
 * de custo (`wa_ai_usage`, origem `acompanhamento-bateria`), como todo uso
 * da API. Imprime a resposta e o que cada ferramenta faria, para leitura.
 *
 * Não é teste automático: o julgamento do tom é de quem lê.
 */
import { processarAcompanhamento } from '../src/services/ai-agent.js';
import { ehPedidoDeSaida, hojeSP } from '../src/services/campanhas.js';
import { contextoDoAluno, ehPedidoDePausa, TEXTO_PAUSA } from '../src/services/acompanhamento/conversa.js';
import { executorDeSimulacao } from '../src/services/acompanhamento/ferramentas.js';
import { textoDaSessao } from '../src/services/acompanhamento/encontros.js';

const hoje = hojeSP();
const somar = (n) => new Date(Date.parse(`${hoje}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const FICHA = {
  aluno: { primeiro_nome: 'Marta', idade: 61 },
  professor: { nome: 'RAFAEL SOUZA' },
  frequencia: { dias_semana: 3 },
  modalidades: [{ nome: 'Musculação' }, { nome: 'Hidroginástica' }],
  trilha: { principal: 'motivacional', secundaria: 'adesao' },
  proxima_avaliacao: somar(40),
  relatorio_aluno: { entregue_em: `${somar(-25)}T15:00:00Z` },
  agenda: {
    sincronizada_em: `${hoje}T10:00:00Z`,
    sessoes: [
      // Horários da grade quando a bateria roda numa quinta (08/10/2026): em outro
      // dia, confira se a aula existe naquele dia da semana.
      { dia: somar(-9), hora: '15:00', modalidade: 'Hidroginástica', presenca: true, finalizada: true },
      { dia: somar(-7), hora: '08:15', modalidade: 'Musculação', presenca: true, finalizada: true },
      { dia: somar(-3), hora: '17:00', modalidade: 'Hidroginástica', presenca: true, finalizada: true },
      { dia: somar(-2), hora: '08:15', modalidade: 'Musculação', presenca: true, finalizada: true },
      { dia: somar(1), hora: '17:00', modalidade: 'Hidroginástica', finalizada: false },
    ],
  },
};
const REGUA = 'Oi, Marta! Passando para saber como estão a hidro e a musculação nesta semana. ' +
  'Você já fez 4 sessões nos últimos 14 dias — bonito de ver! Qualquer coisa, o Rafael está por aqui.';

// A mensagem de reavaliação da régua (situação 'reavaliacao', modelos.ts do
// Prescrev), 7 dias antes. Decisão de 05/11/2026: o "sim" vai ao consultor.
const REAVALIACAO = {
  regua: `Marta, sua reavaliação tá prevista pra ${somar(6).slice(8, 10)}/${somar(6).slice(5, 7)}, e é nela que a gente vê ` +
    'o que mudou desde a primeira. Quer que eu avise a equipe pra reservar um horário?',
  ficha: { proxima_avaliacao: somar(6) },
};

/** A véspera da sessão de testes (Prescrev 060): o lembrete e a marcação na ficha. */
const TESTES = {
  regua: 'Marta, amanhã às 7h30 você faz os testes da sua avaliação com Rogério, na sala de musculação. ' +
    'Vem com roupa de treino. Se precisar mudar o horário, me conta por aqui.',
  ficha: { testes: { inicio: somar(1) + 'T10:30:00.000Z', dia: somar(1), hora: '07:30', duracao_min: 50, professor_id: 'prof-rogerio', professor_nome: 'Rogério Alves' } },
};

/** O encontro de meta (Prescrev 063): o convite 3 dias antes, com horários fictícios no lugar da agenda. */
const SEMANA_LONGA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const extenso = (dia, hora, modalidade) => `${SEMANA_LONGA[new Date(`${dia}T12:00:00Z`).getUTCDay()]}, ${dia.slice(8, 10)}/${dia.slice(5, 7)}, ` +
  `às ${Number(hora.slice(0, 2))}h${hora.slice(3) === '00' ? '' : hora.slice(3)}, na ${modalidade === 'natacao' ? 'natação' : 'musculação'}, com Rafael`;
const util = (n) => { let d = somar(n); while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = somar(++n); return d; };
const D1 = util(3), D2 = util(4), D3 = util(5);
const vaga = (dia, hora, modalidade = 'musculacao') => ({ dia, hora, modalidade, texto: extenso(dia, hora, modalidade) });
const HORARIOS_DO_ENCONTRO = {
  success: true, professor: 'Rafael', marcado: null, periodo: `${D1.slice(8, 10)}/${D1.slice(5, 7)} a ${somar(9).slice(8, 10)}/${somar(9).slice(5, 7)}`,
  na_semana_do_encontro: true,
  sugestoes: [vaga(D1, '08:15'), vaga(D2, '08:15'), vaga(D3, '08:15')],
  outros_horarios: [vaga(D1, '18:15'), vaga(D2, '18:45'), vaga(D3, '19:15'), vaga(D2, '17:45')],
  mensagem: null,
};
const ENCONTRO = {
  regua: `Marta, tá chegando o seu encontro de meta com Rafael: uma conversa rápida pra combinar o próximo passo. ` +
    `Fica bom ${extenso(D1, '08:15', 'musculacao').split(', na')[0].replace(/, às/, ' às')}, na musculação? Já reservo a sessão, que dá pra treinar no mesmo horário.`,
  ficha: { encontro: { semana: 4, de: D1, ate: somar(9), convite: hoje, marcado: null } },
};
const ENCONTRO_MARCADO = {
  regua: 'Marta, amanhã às 8h15 tem o seu encontro de meta com Rafael, na musculação. A sessão já está reservada, ' +
    'porque também vai ter treino. Se precisar mudar, me conta por aqui.',
  ficha: { encontro: { semana: 4, de: D1, ate: somar(9), convite: somar(-3), marcado: { id: 'm1', inicio: `${somar(1)}T11:15:00.000Z`, dia: somar(1), hora: '08:15', modalidade: 'musculacao', professor_id: 'p', professor_nome: 'RAFAEL SOUZA' } } },
};

/**
 * Cada caso: as mensagens do aluno, em ordem (cada uma é uma troca). Um caso
 * também pode ser `{ mensagens, regua, ficha }`: outra mensagem da régua e o
 * que muda na ficha.
 */
const CASOS = {
  reavaliacao_sim: { ...REAVALIACAO, mensagens: ['Sim, quero!', 'Quinta de manhã'] },
  reavaliacao_ja_diz: { ...REAVALIACAO, mensagens: ['Pode sim, de preferência terça à noite'] },
  reavaliacao_agora_nao: { ...REAVALIACAO, mensagens: ['Agora não, depois eu vejo'] },
  testes_remarcar: { ...TESTES, mensagens: ['Não vou conseguir amanhã', 'Pode ser sexta à noite'] },
  testes_remarcar_ja_diz: { ...TESTES, mensagens: ['Dá pra mudar pra segunda de manhã?'] },
  testes_duvida: { ...TESTES, mensagens: ['Preciso levar alguma coisa?'] },
  encontro_aceita: { ...ENCONTRO, mensagens: ['Pode sim!'] },
  encontro_outro: { ...ENCONTRO, mensagens: ['De manhã não dá, tem como à noite?', 'A segunda opção'] },
  encontro_desmarcar: { ...ENCONTRO_MARCADO, mensagens: ['Vou ter que desmarcar, surgiu um compromisso amanhã', 'Agora não, depois eu vejo'] },
  encontro_mudar: { ...ENCONTRO_MARCADO, mensagens: ['Dá pra mudar pra outro dia?'] },
  treino_bom: ['Fiz meu treino ontem e foi ótimo! Consegui fazer tudo sem parar'],
  horario_hidro: ['Que horas tem hidro amanhã?'],
  dor_no_joelho: ['Estou com uma dor no joelho desde a hidro de ontem, dói quando subo escada'],
  dor_professor_fora: ['Estou com uma dor no joelho desde a hidro de ontem, dói quando subo escada'],
  dor_no_peito_fora: ['Hoje subindo a escada senti uma dor no peito e fiquei sem ar, sentei e passou um pouco'],
  dor_no_peito: ['Hoje subindo a escada senti uma dor no peito e fiquei sem ar, sentei e passou um pouco'],
  viagem: ['Vou viajar 15 dias, volto dia 27'],
  boleto: ['Meu boleto deste mês veio com valor diferente do combinado'],
  pausar: ['PAUSAR ACOMPANHAMENTO'],
  sair: ['SAIR'],
  papo: [
    'Oi Leia! Tudo ótimo por aqui!',
    'Estou adorando, o pessoal da hidro é muito animado',
    'Ontem ficamos conversando depois da aula, rimos muito kkk',
    'Obrigada, Leia ❤️',
    'Ah, que horas abre no sábado?',
  ],
};

const ROTULO = (t) => [
  t.desfecho ? `desfecho ${t.desfecho.tipo} — ${t.desfecho.resumo}` : 'SEM DESFECHO',
  ...t.encaminhamentos.map(e => `encaminhou: ${e.categoria} (${e.urgencia}) — ${e.resumo}`),
  t.pausa ? `pausa${t.pausa.ate ? ` até ${t.pausa.ate}` : ''}: ${t.pausa.motivo}` : null,
  t.handoff ? `consultor: ${t.handoff.motivo}` : null,
  ...(t.encontros ?? []).map(e => `encontro: ${e.acao} ${JSON.stringify(e.args ?? {})}`),
].filter(Boolean).join('\n      ');

/** Na bateria, os horários do encontro são os fictícios; marcar devolve o que o APAC devolveria. */
const comEncontro = (exec) => async (nome, args) => {
  if (nome === 'horarios_do_encontro') return HORARIOS_DO_ENCONTRO;
  const r = await exec(nome, args);
  if (nome === 'marcar_encontro') return { ...r, marcado: extenso(args.dia, args.hora, args.modalidade), sessao: 'reservada', mensagem: textoDaSessao('reservada') };
  if (nome === 'desmarcar_encontro') return { ...r, desmarcados: [extenso(somar(1), '08:15', 'musculacao')], mensagem: 'Desmarcado, e a sessão reservada saiu do app. Ofereça outro horário com horarios_do_encontro, se ele quiser.' };
  return r;
};

async function rodar(nome, caso) {
  const { mensagens, regua = REGUA, ficha: mudancas = {} } = Array.isArray(caso) ? { mensagens: caso } : caso;
  const ficha = { ...FICHA, ...mudancas };
  console.log(`\n══ ${nome} ══`);
  console.log(`  [régua] ${regua}`);
  const historico = [];
  let respondidas = 0;
  let encaminhado = null;
  for (const mensagem of mensagens) {
    console.log(`\n  [aluno] ${mensagem}`);
    if (ehPedidoDeSaida(mensagem)) { console.log('  → comando SAIR: supressão; a Leia não responde.'); continue; }
    if (ehPedidoDePausa(mensagem)) { console.log(`  → comando PAUSAR: resposta fixa — ${TEXTO_PAUSA}`); continue; }

    const troca = { troca: respondidas + 1, respondidas, limiteAtingido: respondidas >= 3 };
    const contexto = contextoDoAluno({
      ficha, hoje, troca, simulacao: true,
      ultimaDoAcompanhamento: { texto: regua, quando: 'ontem' },
      encaminhamentoAberto: encaminhado,
      // Um caso com o professor fora do turno pelo resto do dia.
      situacaoDoProfessor: nome.endsWith('_fora') ? { estado: 'nao_hoje', volta: 'amanhã', as: '06:00' } : { estado: 'agora', ate: '21:00' },
    });
    const turno = { desfecho: null, encaminhamentos: [], pausa: null, handoff: null };
    const inicio = Date.now();
    const r = await processarAcompanhamento({
      mensagem, historico, contexto, executar: comEncontro(executorDeSimulacao(turno)), origem: 'acompanhamento-bateria',
    });
    if (r.semResposta && !turno.desfecho) turno.desfecho = { tipo: 'outro', resumo: 'papo depois do limite: sem resposta' };
    const s = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(r.semResposta ? `  [Leia] (sem resposta) · ${s}s` : `  [Leia] ${r.text.replace(/\n/g, '\n         ')}\n         · ${s}s`);
    console.log(`      ${ROTULO(turno)}`);

    historico.push({ role: 'user', content: mensagem });
    if (!r.semResposta) { historico.push({ role: 'assistant', content: r.text }); respondidas++; }
    else historico.pop();
    if (turno.encaminhamentos[0] && !encaminhado) encaminhado = { motivo: turno.encaminhamentos[0].categoria, quando: 'hoje' };
  }
}

const pedidos = process.argv.slice(2);
for (const [nome, mensagens] of Object.entries(CASOS)) {
  if (pedidos.length && !pedidos.includes(nome)) continue;
  try {
    await rodar(nome, mensagens);
  } catch (err) {
    console.log(`  ERRO: ${err.message}`);
  }
}
process.exit(0);
