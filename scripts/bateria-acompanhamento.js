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

/** Cada caso: as mensagens do aluno, em ordem (cada uma é uma troca). */
const CASOS = {
  treino_bom: ['Fiz meu treino ontem e foi ótimo! Consegui fazer tudo sem parar'],
  horario_hidro: ['Que horas tem hidro amanhã?'],
  dor_no_joelho: ['Estou com uma dor no joelho desde a hidro de ontem, dói quando subo escada'],
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
].filter(Boolean).join('\n      ');

async function rodar(nome, mensagens) {
  console.log(`\n══ ${nome} ══`);
  console.log(`  [régua] ${REGUA}`);
  const historico = [];
  let respondidas = 0;
  let encaminhado = null;
  for (const mensagem of mensagens) {
    console.log(`\n  [aluno] ${mensagem}`);
    if (ehPedidoDeSaida(mensagem)) { console.log('  → comando SAIR: supressão; a Leia não responde.'); continue; }
    if (ehPedidoDePausa(mensagem)) { console.log(`  → comando PAUSAR: resposta fixa — ${TEXTO_PAUSA}`); continue; }

    const troca = { troca: respondidas + 1, respondidas, limiteAtingido: respondidas >= 3 };
    const contexto = contextoDoAluno({
      ficha: FICHA, hoje, troca, simulacao: true,
      ultimaDoAcompanhamento: { texto: REGUA, quando: 'ontem' },
      encaminhamentoAberto: encaminhado,
    });
    const turno = { desfecho: null, encaminhamentos: [], pausa: null, handoff: null };
    const inicio = Date.now();
    const r = await processarAcompanhamento({
      mensagem, historico, contexto, executar: executorDeSimulacao(turno), origem: 'acompanhamento-bateria',
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
