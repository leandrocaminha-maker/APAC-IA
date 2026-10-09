/**
 * Testes da conversa da Leia no acompanhamento. Puros, sem `.env`.
 * 08/10/2026 é quinta-feira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENT_BY_LEIA, SENT_BY_REGUA, contextoDoAluno, ehPedidoDePausa, presencasRecentes, proximasSessoes, trocaAtual,
} from './conversa.js';
import { FERRAMENTAS, executorDeSimulacao } from './ferramentas.js';

const regua = { direction: 'outbound', sent_by: SENT_BY_REGUA };
const leia = { direction: 'outbound', sent_by: SENT_BY_LEIA };
const aluno = { direction: 'inbound', sent_by: 'simulador' };

test('a troca conta as respostas da Leia desde a última mensagem da régua', () => {
  assert.deepEqual(trocaAtual([regua, aluno]), { troca: 1, respondidas: 0, limiteAtingido: false });
  assert.deepEqual(trocaAtual([regua, aluno, leia, aluno, leia, aluno]), { troca: 3, respondidas: 2, limiteAtingido: false });
  assert.deepEqual(trocaAtual([regua, aluno, leia, aluno, leia, aluno, leia, aluno]).limiteAtingido, true);
  // mensagem nova da régua recomeça a contagem
  assert.deepEqual(trocaAtual([regua, aluno, leia, aluno, leia, aluno, leia, regua, aluno]).troca, 1);
  // a fala de um consultor não conta como troca da Leia
  assert.equal(trocaAtual([regua, aluno, { direction: 'outbound', sent_by: 'human:ana' }, aluno]).troca, 1);
});

const FICHA = {
  aluno: { primeiro_nome: 'Marta', idade: 61 },
  professor: { nome: 'RAFAEL SOUZA' },
  frequencia: { dias_semana: 3 },
  modalidades: [{ nome: 'Musculação' }, { nome: 'Hidroginástica' }],
  trilha: { principal: 'adesao', secundaria: 'motivacional' },
  proxima_avaliacao: '2026-11-20',
  relatorio_aluno: { entregue_em: '2026-09-20T15:00:00Z' },
  agenda: {
    sincronizada_em: '2026-10-08T10:00:00Z',
    sessoes: [
      { dia: '2026-10-01', hora: '07:00', modalidade: 'Hidroginástica', presenca: true, finalizada: true },
      { dia: '2026-10-03', hora: '08:00:00', modalidade: 'Musculação', presenca: true, finalizada: true },
      { dia: '2026-10-06', hora: '08:00', modalidade: 'Musculação', presenca: false, falta: true, finalizada: true },
      { dia: '2026-09-20', hora: '07:00', modalidade: 'Hidroginástica', presenca: true, finalizada: true }, // fora dos 14 dias
      { dia: '2026-10-09', hora: '07:00:00', modalidade: 'Hidroginástica', finalizada: false },
    ],
  },
};

test('presenças dos 14 dias por modalidade, e as próximas sessões', () => {
  assert.deepEqual(presencasRecentes(FICHA, '2026-10-08'), { total: 2, texto: 'Hidroginástica 1, Musculação 1' });
  assert.deepEqual(proximasSessoes(FICHA, '2026-10-08'), ['sex 09/10 07:00 Hidroginástica']);
  assert.equal(presencasRecentes({ ...FICHA, agenda: null }, '2026-10-08'), null);
});

test('o contexto do aluno: curto, com o tom e sem o que não sai', () => {
  const ctx = contextoDoAluno({
    ficha: FICHA, hoje: '2026-10-08', troca: { troca: 3, respondidas: 2, limiteAtingido: false },
    ultimaDoAcompanhamento: { texto: 'Oi, Marta! Como foi a semana?', quando: '07/10' },
  });
  assert.match(ctx, /- Nome: Marta, 61 anos/);
  assert.match(ctx, /- Professor: Rafael\n/);
  assert.match(ctx, /- Combinado: 3× por semana — Musculação, Hidroginástica/);
  assert.match(ctx, /- Trilha \(decide o tom; nunca diga o nome\): adesão \(2ª: motivacional\)/);
  assert.match(ctx, /- Próxima reavaliação: 20\/11\/2026/);
  assert.match(ctx, /- Presenças nos últimos 14 dias: 2 \(Hidroginástica 1, Musculação 1\)/);
  assert.match(ctx, /respondeu \(07\/10\): «Oi, Marta! Como foi a semana\?»/);
  assert.match(ctx, /- Esta é a troca 3 de 3, a última: responda e dê o encaminhamento ao professor\./);
  assert.match(contextoDoAluno({ ficha: FICHA, hoje: '2026-10-08', troca: { troca: 2, respondidas: 1, limiteAtingido: false } }),
    /- Esta é a troca 2 de 3: converse normalmente; o encaminhamento pelo limite é só na 3ª\./);
  assert.ok(ctx.split('\n').length <= 14, 'contexto comprido demais');

  const depois = contextoDoAluno({ ficha: { ...FICHA, proxima_avaliacao: '2026-10-01', agenda: null }, hoje: '2026-10-08',
    troca: { troca: 4, respondidas: 3, limiteAtingido: true }, encaminhamentoAberto: { motivo: 'dor ou lesão', quando: 'em 08/10' } });
  assert.match(depois, /Limite de trocas atingido/);
  assert.match(depois, /sem data marcada/);
  assert.match(depois, /sem agenda carregada — não afirme presença nem falta/);
  assert.match(depois, /Já encaminhado ao professor: dor ou lesão \(em 08\/10\) — não abra outro/);
});

test('PAUSAR ACOMPANHAMENTO é comando só sozinho', () => {
  assert.deepEqual(['PAUSAR ACOMPANHAMENTO', 'pausar acompanhamento!', ' Pausar  Acompanhamento '].map(ehPedidoDePausa), [true, true, true]);
  assert.deepEqual(['quero pausar acompanhamento por 15 dias', 'pausar', 'PARAR ACOMPANHAMENTO'].map(ehPedidoDePausa), [false, false, false]);
});

test('as ferramentas: lista fixa, e a simulação só registra', async () => {
  assert.deepEqual(FERRAMENTAS.map(f => f?.name),
    ['registrar_desfecho', 'encaminhar_ao_professor', 'pausar_acompanhamento', 'transferir_para_humano']);
  const turno = { desfecho: null, encaminhamentos: [], pausa: null, handoff: null };
  const exec = executorDeSimulacao(turno);
  await exec('registrar_desfecho', { tipo: 'encaminhamento', resumo: 'dor no joelho na hidro' });
  await exec('encaminhar_ao_professor', { categoria: 'dor_ou_lesao', urgencia: 'hoje', resumo_para_professor: 'dor no joelho' });
  const h = await exec('transferir_para_humano', { motivo: 'boleto', mensagem: 'Vou chamar o consultor.' });
  assert.deepEqual(turno.desfecho, { tipo: 'encaminhamento', resumo: 'dor no joelho na hidro' });
  assert.deepEqual(turno.encaminhamentos, [{ categoria: 'dor_ou_lesao', urgencia: 'hoje', resumo: 'dor no joelho' }]);
  assert.equal(h.action, 'handoff');
  assert.equal((await exec('registrar_desfecho', { tipo: 'xpto', resumo: '' })).success, false);
  assert.equal((await exec('agendar_aula_experimental', {})).success, false);
});

test('a linha do professor diz se ele ainda trabalha hoje', async () => {
  const { textoDoProfessorHoje } = await import('./conversa.js');
  assert.equal(textoDoProfessorHoje({ estado: 'agora', ate: '21:00' }), ' — trabalhando agora, até 21:00');
  assert.equal(textoDoProfessorHoje({ estado: 'mais_tarde', as: '17:00' }), ' — chega hoje às 17:00');
  assert.equal(textoDoProfessorHoje({ estado: 'nao_hoje', volta: 'amanhã', as: '06:00' }), ' — não trabalha mais hoje; volta amanhã às 06:00');
  assert.equal(textoDoProfessorHoje({ estado: 'nao_hoje', volta: 'segunda', as: '06:00' }), ' — não trabalha mais hoje; volta na segunda às 06:00');
  assert.equal(textoDoProfessorHoje({ estado: 'nao_hoje', volta: 'sábado', as: '08:00' }), ' — não trabalha mais hoje; volta no sábado às 08:00');
  assert.match(textoDoProfessorHoje(null), /sem horário cadastrado/);
  assert.equal(textoDoProfessorHoje(undefined), '');
  const ctx = contextoDoAluno({ ficha: FICHA, hoje: '2026-10-08', troca: { troca: 1, respondidas: 0, limiteAtingido: false },
    situacaoDoProfessor: { estado: 'nao_hoje', volta: 'amanhã', as: '06:00' } });
  assert.match(ctx, /- Professor: Rafael — não trabalha mais hoje/);
});
