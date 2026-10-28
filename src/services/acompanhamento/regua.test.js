/**
 * Testes da régua e do preenchimento do acompanhamento.
 *
 *   node --test src/services/acompanhamento/
 *
 * Puros: não leem `.env` nem banco. Os modelos e a ficha abaixo têm a forma
 * do que o Prescrev publica (/api/acompanhamento/modelos e /fichas).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diasEntre, horaPorExtenso, preencher, valoresDaFicha } from './render.js';
import {
  PRIORIDADE, avisosDaEquipe, camadasDe, candidatosDe, cicloDoTreino, decidir, diaPorExtenso, emLista, emRodizio, fasesDaFicha, horaPrevista, resumirTreinos, treinoVigente, leituraDaAgenda, limiteAusencia, modalidadesNaAgenda, situacaoDoDia,
} from './regua.js';

const ficha = (mudar = {}) => ({
  cliente_id: 'c1',
  versao: 2,
  aluno: { primeiro_nome: 'Claudia' },
  estado: { pausado_ate: null, encerrado: false },
  trilha: { principal: 'desafiador', secundaria: 'tecnico', adesao_ate_estabilizar: false, cadencia_dias: 14, cadencia_origem: 'trilha' },
  proxima_avaliacao: '2026-11-21',
  marcadores: {
    nome: 'Claudia', periodo: 'manhã', capacidade: 'hipertrofia', professor: 'Vanessa',
    frequencia: '5 vezes por semana', cadencia: '14', meta: '10 treinos', proxima_avaliacao: '21/11',
  },
  ...mudar,
});

const modelos = [
  { id: 'rotina:desafiador:a', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, faltam {dias_avaliacao} dias.', envio: 'sozinha' },
  { id: 'rotina:desafiador:b', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, desafio: treinar {frequencia}.', envio: 'sozinha' },
  { id: 'rotina:desafiador:c', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, marca {marca}.', envio: 'nao' },
  { id: 'rotina:adesao:a', situacao: 'rotina', trilha: 'adesao', texto: 'Oi, {nome}!', envio: 'sozinha' },
  { id: 'boas_vindas:todas:a', situacao: 'boas_vindas', trilha: 'todas', texto: 'Oi, {nome}! A cada {cadencia} dias.', envio: 'sozinha' },
  { id: 'reavaliacao:todas:a', situacao: 'reavaliacao', trilha: 'todas', texto: '{nome}, reavaliação em {proxima_avaliacao}.', envio: 'sozinha' },
  { id: 'ausencia:adesao:a', situacao: 'ausencia', trilha: 'adesao', texto: 'Sentimos sua falta, {nome}.', envio: 'sozinha' },
  { id: 'ausencia:todas:a', situacao: 'ausencia', trilha: 'todas', texto: 'Faz {dias} dias, {nome}.', envio: 'evo' },
];

const decidirEm = (hoje, historico, f = ficha(), modo = 'ensaio') => decidir({ ficha: f, modelos, historico, hoje, modo });

// ---- render ----

test('dias entre datas', () => {
  assert.equal(diasEntre('2026-10-08', '2026-11-21'), 44);
  assert.equal(diasEntre('2026-10-08', '2026-10-08'), 0);
  assert.equal(diasEntre('2026-10-08', '2026-10-01'), -7);
  assert.equal(diasEntre('2026-02-28', '2026-03-01'), 1);
});

test('preencher: tudo com valor', () => {
  assert.deepEqual(preencher('Oi, {nome}! {frequencia}.', { nome: 'Ana', frequencia: '3 vezes por semana' }),
    { texto: 'Oi, Ana! 3 vezes por semana.', faltam: [] });
});

test('preencher: marcador sem valor tira o texto inteiro, e diz qual', () => {
  assert.deepEqual(preencher('Oi, {nome}, faz {dias} dias, {dia}.', { nome: 'Ana', dias: null }),
    { texto: null, faltam: ['dias', 'dia'] });
  assert.deepEqual(preencher('{nome}', { nome: '  ' }), { texto: null, faltam: ['nome'] });
});

test('{dias_avaliacao} se conta no dia, e só de 2 para cima', () => {
  assert.equal(valoresDaFicha(ficha(), '2026-10-08').dias_avaliacao, '44');
  assert.equal(valoresDaFicha(ficha(), '2026-11-20').dias_avaliacao, null);
  assert.equal(valoresDaFicha(ficha(), '2026-11-22').dias_avaliacao, null);
  assert.equal(valoresDaFicha(ficha({ proxima_avaliacao: null }), '2026-10-08').dias_avaliacao, null);
});

// ---- situação ----

test('sem histórico: boas-vindas no ensaio, espera a ativação no envio', () => {
  assert.equal(situacaoDoDia({ ficha: ficha(), anteriores: [], hoje: '2026-10-08', modo: 'ensaio' }).situacao, 'boas_vindas');
  assert.equal(situacaoDoDia({ ficha: ficha(), anteriores: [], hoje: '2026-10-08', modo: 'envio' }).situacao, null);
});

test('rotina quando passa a cadência, contando de qualquer mensagem', () => {
  const h = [{ dia: '2026-10-08', situacao: 'boas_vindas', modelo_id: 'boas_vindas:todas:a' }];
  assert.equal(decidirEm('2026-10-21', h).status, 'nada');
  assert.match(decidirEm('2026-10-21', h).motivo, /Próxima rotina em 1 dia/);
  assert.equal(decidirEm('2026-10-22', h).situacao, 'rotina');
});

test('reavaliação 7 dias antes, uma vez por data, e zera o relógio da rotina', () => {
  const h = [{ dia: '2026-11-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  assert.equal(decidirEm('2026-11-13', h).status, 'nada');           // 8 dias antes
  const d = decidirEm('2026-11-14', h);                               // 7 dias antes
  assert.equal(d.situacao, 'reavaliacao');
  assert.equal(d.texto, 'Claudia, reavaliação em 21/11.');
  const depois = [...h, { dia: '2026-11-14', situacao: 'reavaliacao', modelo_id: d.modelo_id }];
  assert.equal(decidirEm('2026-11-16', depois).status, 'nada');      // já avisou
  assert.match(decidirEm('2026-11-16', depois).motivo, /última em 14\/11/);
});

test('data da avaliação que já passou não dispara reavaliação', () => {
  const h = [{ dia: '2026-11-25', situacao: 'rotina', modelo_id: 'x' }];
  assert.notEqual(decidirEm('2026-11-26', h).situacao, 'reavaliacao');
});

test('pausa e encerramento calam a régua, com o motivo', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const pausada = ficha({ estado: { pausado_ate: '2026-10-30', encerrado: false } });
  assert.deepEqual([decidirEm('2026-10-20', h, pausada).status, decidirEm('2026-10-20', h, pausada).motivo],
    ['nada', 'Pausado até 30/10.']);
  assert.equal(decidirEm('2026-10-31', h, pausada).situacao, 'rotina');
  assert.equal(decidirEm('2026-10-20', h, ficha({ estado: { encerrado: true } })).motivo, 'Acompanhamento encerrado no Prescrev.');
});

test('o mesmo dia rodado de novo não faz o relógio andar', () => {
  const h = [{ dia: '2026-10-08', situacao: 'boas_vindas', modelo_id: 'boas_vindas:todas:a' }];
  assert.equal(decidirEm('2026-10-08', h).situacao, 'boas_vindas');
});

// ---- modelo ----

test('candidatos: rotina só da trilha; situação da trilha antes de "todas"', () => {
  assert.deepEqual(candidatosDe(modelos, 'rotina', 'desafiador').map(m => m.id),
    ['rotina:desafiador:a', 'rotina:desafiador:b', 'rotina:desafiador:c']);
  assert.deepEqual(candidatosDe(modelos, 'ausencia', 'adesao').map(m => m.id), ['ausencia:adesao:a']);
  assert.deepEqual(candidatosDe(modelos, 'ausencia', 'tecnico').map(m => m.id), ['ausencia:todas:a']);
});

test('rodízio começa depois do último usado', () => {
  const c = candidatosDe(modelos, 'rotina', 'desafiador');
  assert.deepEqual(emRodizio(c, 'rotina:desafiador:a').map(m => m.id),
    ['rotina:desafiador:b', 'rotina:desafiador:c', 'rotina:desafiador:a']);
  assert.deepEqual(emRodizio(c, 'id-que-sumiu').map(m => m.id), c.map(m => m.id));
});

test('rotina alterna os modelos e pula o que não pode sair sozinho', () => {
  const h1 = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const d1 = decidirEm('2026-10-20', h1);
  assert.deepEqual([d1.status, d1.modelo_id, d1.texto],
    ['simulado', 'rotina:desafiador:b', 'Claudia, desafio: treinar 5 vezes por semana.']);
  // depois do b vem o c, que não sai sozinho ({marca}); volta ao a
  const h2 = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:b' }];
  assert.equal(decidirEm('2026-10-20', h2).modelo_id, 'rotina:desafiador:a');
});

test('modelo com marcador sem valor passa ao seguinte; nenhum, bloqueia e diz o que falta', () => {
  const semFreq = ficha({ marcadores: { ...ficha().marcadores, frequencia: null }, proxima_avaliacao: null });
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const d = decidirEm('2026-10-20', h, semFreq);
  assert.equal(d.status, 'bloqueado');
  assert.deepEqual(d.bloqueios, ['Nenhum modelo de rotina com todos os marcadores: falta {dias_avaliacao}, {frequencia}.']);
});

const ATIVA = { status: 'ativa', ativadoEm: '2026-09-30', pausadoAte: null };
const decidirNoEnvio = (hoje, historico, mudar = {}) =>
  decidir({ ficha: ficha(), modelos, historico, hoje, modo: 'envio', inscricao: ATIVA, ...mudar });

test('no envio a decisão fica pendente, e não simulada', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidirNoEnvio('2026-10-20', h).status, 'pendente');
});

test('no envio, só quem ativou: sem inscrição nada sai; no ensaio, o motivo avisa', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  assert.deepEqual(['status', 'motivo'].map(k => decidirNoEnvio('2026-10-20', h, { inscricao: null })[k]),
    ['nada', 'O aluno não ativou o WhatsApp.']);
  const ensaio = decidir({ ficha: ficha(), modelos, historico: h, hoje: '2026-10-20', modo: 'ensaio', inscricao: null });
  assert.equal(ensaio.status, 'simulado');
  assert.match(ensaio.motivo, /No envio real não sairia: o aluno ainda não ativou o WhatsApp\.$/);
});

test('a boas-vindas da trilha sai no dia seguinte ao aceite', () => {
  assert.equal(decidirNoEnvio('2026-10-08', [], { inscricao: { ...ATIVA, ativadoEm: '2026-10-08' } }).motivo,
    'Ativou hoje: a boas-vindas da trilha sai amanhã.');
  const amanha = decidirNoEnvio('2026-10-09', [], { inscricao: { ...ATIVA, ativadoEm: '2026-10-08' } });
  assert.deepEqual([amanha.status, amanha.situacao], ['pendente', 'boas_vindas']);
});

test('pausa do aluno cala a régua até a data — e depois dela, volta', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const pausada = { ...ATIVA, status: 'pausada', pausadoAte: '2026-10-25' };
  assert.equal(decidirNoEnvio('2026-10-20', h, { inscricao: pausada }).motivo, 'Pausado pelo aluno até 25/10.');
  assert.equal(decidirNoEnvio('2026-10-26', h, { inscricao: pausada }).status, 'pendente');
  assert.equal(decidirNoEnvio('2026-10-26', h, { inscricao: { ...pausada, pausadoAte: null } }).status, 'nada');
});

test('freio: três sem resposta e sem presença param a rotina — aviso na adesão, pausa nas outras', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const outra = decidirNoEnvio('2026-10-20', h, { semResposta: 3 });
  assert.deepEqual([outra.status, outra.freio, outra.avisos_equipe.length], ['nada', 'pausa', 0]);
  const adesao = decidir({ ficha: ficha({ trilha: { ...ficha().trilha, principal: 'adesao', cadencia_dias: 3 } }),
    modelos, historico: h, hoje: '2026-10-20', modo: 'envio', inscricao: ATIVA, semResposta: 3 });
  assert.deepEqual([adesao.status, adesao.freio], ['nada', 'aviso']);
  assert.deepEqual(adesao.avisos_equipe.map(a => [a.codigo, a.referencia]), [['tres_sem_resposta', '2026-10-01']]);
  // duas sem resposta ainda não freiam
  assert.equal(decidirNoEnvio('2026-10-20', h, { semResposta: 2 }).status, 'pendente');
});

test('trilha sem modelo da situação bloqueia com o motivo', () => {
  const d = decidir({ ficha: ficha({ trilha: { ...ficha().trilha, principal: 'tecnico' } }), modelos, historico: [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }], hoje: '2026-10-20', modo: 'ensaio' });
  assert.deepEqual([d.status, d.bloqueios], ['bloqueado', ['Nenhum modelo de rotina para a trilha tecnico.']]);
});

// ---- hora ----

const SEMANA = { inicioMin: 9 * 60, fimMin: 20 * 60 + 30 };
const SABADO = { inicioMin: 9 * 60, fimMin: 13 * 60 };
/** Minuto do dia em São Paulo de um Date. */
const minutoSP = (d) => ((d.getUTCHours() + 21) % 24) * 60 + d.getUTCMinutes();

test('hora prevista: começo do período, dentro da janela, espalhada por aluno', () => {
  const manha = horaPrevista(ficha(), '2026-10-08', SEMANA);
  assert.equal(manha.toISOString().slice(0, 10), '2026-10-08');
  assert.ok(minutoSP(manha) >= 9 * 60 && minutoSP(manha) <= 9 * 60 + 40, minutoSP(manha));
  const noite = horaPrevista(ficha({ marcadores: { ...ficha().marcadores, periodo: 'noite' } }), '2026-10-08', SEMANA);
  assert.ok(minutoSP(noite) >= 18 * 60 && minutoSP(noite) <= 18 * 60 + 40);
  // sábado a janela fecha às 13h: a noite não passa das 12h45
  const sabado = horaPrevista(ficha({ marcadores: { ...ficha().marcadores, periodo: 'noite' } }), '2026-10-10', SABADO);
  assert.ok(minutoSP(sabado) <= 12 * 60 + 45, minutoSP(sabado));
  // o mesmo aluno cai sempre no mesmo minuto
  assert.equal(horaPrevista(ficha(), '2026-10-08', SEMANA).getTime(), manha.getTime());
});

test('{proxima_avaliacao} perde o valor depois da data', () => {
  assert.equal(valoresDaFicha(ficha(), '2026-11-21').proxima_avaliacao, '21/11');
  assert.equal(valoresDaFicha(ficha(), '2026-11-22').proxima_avaliacao, null);
  // e o modelo que a usa sai da vez: o rodízio passa ao seguinte
  const h = [{ dia: '2026-11-10', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const ficha2 = ficha({ trilha: { ...ficha().trilha, cadencia_dias: 14 } });
  const so = [{ id: 'r:x', situacao: 'rotina', trilha: 'desafiador', texto: 'Reavaliação em {proxima_avaliacao}.', envio: 'sozinha' }];
  assert.equal(decidir({ ficha: ficha2, modelos: so, historico: h, hoje: '2026-11-28', modo: 'ensaio' }).status, 'bloqueado');
});

// ---- agenda: ausência, retorno, modalidade sem agendamento ----


const NOME_DA_ATIVIDADE = { 18: 'Musculação', 22: 'Mat Pilates', 158: 'Mat Pilates' };
const sessao = (dia, atividade, { presenca = true, finalizada = true } = {}) =>
  ({ dia, hora: '07:00', atividade_evo: atividade, modalidade: NOME_DA_ATIVIDADE[atividade] ?? null,
     presenca, falta: !presenca, justificada: false, finalizada });

/** Carga de domingo 11/10 às 2h10 em São Paulo. */
const comAgenda = (sessoes, mudar = {}) => ficha({
  frequencia: { dias_semana: 3, fonte: 'prescricao' },
  relatorio_aluno: { entregue_em: '2026-09-01T15:00:00Z' },
  ciclos: [{ descricao: 'adaptação', frequencia_semanal: 3, duracao_semanas: 4, minimo_treinos: 10 }],
  modalidades: [
    { slug: 'musculacao', nome: 'Musculação', frequencia_semanal: null, atividades_evo: [18, 41] },
    { slug: 'mat_pilates', nome: 'Mat Pilates', frequencia_semanal: 1, atividades_evo: [22, 158, 159] },
    { slug: 'caminhada', nome: 'Caminhada', frequencia_semanal: 2, atividades_evo: [] },
  ],
  agenda: { sincronizada_em: '2026-10-11T05:10:00Z', sessoes },
  proxima_avaliacao: null,
  ...mudar,
});

const modelosAgenda = [
  ...modelos,
  { id: 'retorno:todas:a', situacao: 'retorno', trilha: 'todas', texto: '{nome}, vi que você fez {atividade_retorno} {dia_retorno}.', envio: 'evo' },
  { id: 'sem_agendamento:todas:a', situacao: 'sem_agendamento', trilha: 'todas', texto: '{nome}, {modalidade} ainda não apareceu.', envio: 'evo' },
  { id: 'ausencia:desafiador:a', situacao: 'ausencia', trilha: 'desafiador', texto: '{nome}, {dias} dias sem treino.', envio: 'evo' },
];
const h0 = [{ dia: '2026-10-05', situacao: 'rotina', modelo_id: 'x', valores: {} }];
const decidirAgenda = (f, hoje, historico = h0, sinais = []) => decidir({ ficha: f, modelos: modelosAgenda, historico, sinais, hoje, modo: 'ensaio' });

test('limite de ausência: o prazo da ficha; sem ele, 10 dias para todos (M0)', () => {
  assert.equal(limiteAusencia(ficha()), 10);
  assert.equal(limiteAusencia(ficha({ frequencia: { dias_semana: 1, fonte: 'prescricao' } })), 10);
  assert.equal(limiteAusencia(ficha({ comportamento: { ausencia: { prazos: { aviso: 12 } } } })), 12);
});

test('a agenda se lê no dia da carga, e presença só vale em aula finalizada', () => {
  const a = leituraDaAgenda(comAgenda([sessao('2026-10-02', 18), sessao('2026-10-09', 18, { finalizada: false }), sessao('2026-10-13', 18)]));
  assert.deepEqual([a.carga, a.inicio, a.ultimaPresenca], ['2026-10-11', '2026-09-01', '2026-10-02']);
});

test('modalidades que se conferem pela agenda: casadas e prescritas', () => {
  assert.deepEqual(modalidadesNaAgenda(comAgenda([])).map(m => m.slug), ['musculacao', 'mat_pilates']);
  // musculação sem frequência e sem ciclo não está prescrita
  assert.deepEqual(modalidadesNaAgenda(comAgenda([], { ciclos: [] })).map(m => m.slug), ['mat_pilates']);
});

const avisoEVO = (dia, dias) => [{ dia, dias }];
// A última presença 10 dias antes do aviso de 12/10: a agenda não o contradiz.
const semPresenca = comAgenda([sessao('2026-10-02', 18), sessao('2026-10-02', 22)]);

test('ausência pelo aviso do EVO, no limite, com {dias}', () => {
  const d = decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-12', 10));
  assert.deepEqual([d.situacao, d.texto], ['ausencia', 'Claudia, 10 dias sem treino.']);
  assert.match(d.motivo, /Aviso "Sem presença" do EVO em 12\/10: 10 dias; limite de 10 dias/);
});

test('sem aviso do EVO não há ausência — a agenda semanal sozinha não decide', () => {
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-12').situacao, 'ausencia');
});

test('aviso abaixo do limite não conta, seja qual for a frequência', () => {
  const duas = comAgenda([], { frequencia: { dias_semana: 2, fonte: 'prescricao' } });
  const cinco = comAgenda([], { frequencia: { dias_semana: 5, fonte: 'prescricao' } });
  assert.notEqual(decidirAgenda(duas, '2026-10-12', h0, avisoEVO('2026-10-12', 9)).situacao, 'ausencia');
  assert.notEqual(decidirAgenda(cinco, '2026-10-12', h0, avisoEVO('2026-10-12', 9)).situacao, 'ausencia');
  assert.equal(decidirAgenda(duas, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).situacao, 'ausencia');
  assert.equal(decidirAgenda(cinco, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).situacao, 'ausencia');
});

test('aviso de mais de 2 dias não vira mensagem', () => {
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-09', 10)).situacao, 'ausencia');
});

test('aviso sem o número de dias vale; o modelo com {dias} não sai, e o sem {dias} sai', () => {
  const d = decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-12', null));
  assert.deepEqual([d.situacao, d.status, d.bloqueios], ['ausencia', 'bloqueado', ['Nenhum modelo de ausencia com todos os marcadores: falta {dias}.']]);
  const adesao = comAgenda([], { trilha: { ...ficha().trilha, principal: 'adesao' } });
  assert.equal(decidirAgenda(adesao, '2026-10-12', h0, avisoEVO('2026-10-12', null)).texto, 'Sentimos sua falta, Claudia.');
});

test('aviso contradito pela agenda não sai, e o motivo diz por quê', () => {
  // musculação e pilates na agenda: nada mais devido no dia, e o motivo é o da contradição
  const f = comAgenda([sessao('2026-10-09', 18), sessao('2026-10-09', 22)]);
  const d = decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 10));
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /Aviso "Sem presença" do EVO de 12\/10 contradito pela agenda \(presença em 09\/10\): não sai/);
});

test('aula ainda não finalizada não contradiz o aviso', () => {
  const f = comAgenda([sessao('2026-10-09', 18, { finalizada: false })]);
  assert.equal(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).situacao, 'ausencia');
});

test('uma mensagem por aviso', () => {
  const h = [...h0, { dia: '2026-10-12', situacao: 'ausencia', modelo_id: 'ausencia:desafiador:a', valores: { dias: '10' } }];
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-13', h, avisoEVO('2026-10-12', 10)).situacao, 'ausencia');
});

test('na adesão, o motivo lembra que o professor recebe o aviso junto (D6)', () => {
  const f = comAgenda([], { trilha: { ...ficha().trilha, principal: 'adesao' } });
  assert.match(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).motivo, /professor recebe o aviso junto \(D6/);
});

test('o dia da volta por extenso, com a preposição certa', () => {
  assert.deepEqual(['2026-10-16', '2026-10-10', '2026-10-11'].map(diaPorExtenso),
    ['na sexta, 16/10', 'no sábado, 10/10', 'no domingo, 11/10']);
});

test('retorno: diz o dia e a atividade da volta, mesmo dias depois', () => {
  const h = [...h0, { dia: '2026-10-12', situacao: 'ausencia', modelo_id: 'x', valores: {} }];
  const agenda = { sincronizada_em: '2026-10-18T05:10:00Z', sessoes: [sessao('2026-10-03', 18), sessao('2026-10-16', 22), sessao('2026-10-17', 18)] };
  const f = comAgenda([], { agenda });
  const d = decidirAgenda(f, '2026-10-19', h);
  assert.deepEqual([d.situacao, d.texto], ['retorno', 'Claudia, vi que você fez Mat Pilates na sexta, 16/10.']);
  assert.match(d.motivo, /Presença em 16\/10, depois do aviso de ausência de 12\/10 \(agenda de 18\/10\)/);
  assert.equal(decidirAgenda(f, '2026-10-24', h).situacao, 'retorno');   // a frase é datada: não expira em 3 dias
  const depois = [...h, { dia: '2026-10-19', situacao: 'retorno', modelo_id: 'retorno:todas:a', valores: {} }];
  assert.notEqual(decidirAgenda(f, '2026-10-20', depois).situacao, 'retorno');
});

test('retorno em atividade fora do catálogo: o modelo sem valor não sai', () => {
  const h = [...h0, { dia: '2026-10-12', situacao: 'ausencia', modelo_id: 'x', valores: {} }];
  const f = comAgenda([], { agenda: { sincronizada_em: '2026-10-18T05:10:00Z', sessoes: [sessao('2026-10-16', 999)] } });
  const d = decidirAgenda(f, '2026-10-19', h);
  assert.deepEqual([d.situacao, d.status], ['retorno', 'bloqueado']);
});

test('modalidade sem agendamento em 3 semanas: todas numa mensagem, e não repete em 3 semanas', () => {
  const f = comAgenda([sessao('2026-10-08', 18), sessao('2026-10-10', 18)]);
  const d = decidirAgenda(f, '2026-10-13');
  assert.deepEqual([d.situacao, d.texto], ['sem_agendamento', 'Claudia, Mat Pilates ainda não apareceu.']);
  assert.match(d.motivo, /Nenhum agendamento na agenda do EVO de 20\/09 a 11\/10: Mat Pilates/);
  const h = [...h0, { dia: '2026-10-13', situacao: 'sem_agendamento', modelo_id: d.modelo_id, valores: { modalidade: 'Mat Pilates' } }];
  assert.notEqual(decidirAgenda(f, '2026-10-14', h).situacao, 'sem_agendamento');
  assert.notEqual(decidirAgenda(f, '2026-11-02', h).situacao, 'sem_agendamento');   // 20 dias depois
  // sem musculação na agenda também: as duas na mesma mensagem
  const duas = decidirAgenda(comAgenda([]), '2026-10-13');
  assert.equal(duas.valores.modalidade, 'Musculação e Mat Pilates');
});

test('modalidade sem agendamento: o professor do aluno recebe o pedido de avisar o responsável pela modalidade', () => {
  const d = decidirAgenda(comAgenda([sessao('2026-10-08', 18), sessao('2026-10-10', 18)]), '2026-10-13');
  const aviso = d.avisos_equipe.find(a => a.codigo === 'sem_agendamento');
  assert.deepEqual([aviso.referencia, aviso.urgencia], ['2026-10-13', 'proximos_dias']);
  assert.equal(aviso.texto, 'Mat Pilates está no programa e sem nenhum agendamento na agenda do EVO nas últimas 3 semanas. ' +
    'A Leia já ofereceu ajuda pra achar um horário. Avisa o professor responsável pela modalidade: o convite de quem dá a ' +
    'aula deixa a primeira ida bem mais fácil.');
  // duas modalidades: plural no texto e no motivo
  const duas = decidirAgenda(comAgenda([]), '2026-10-13').avisos_equipe.find(a => a.codigo === 'sem_agendamento');
  assert.match(duas.texto, /^Musculação e Mat Pilates estão no programa .* Avisa os professores responsáveis pelas modalidades:/);
  assert.equal(duas.motivo, 'modalidades do programa sem agendamento');
  // sem a situação no dia, não há aviso
  const h = [...h0, { dia: '2026-10-13', situacao: 'sem_agendamento', modelo_id: 'x', valores: { modalidade: 'Mat Pilates' } }];
  const depois = decidirAgenda(comAgenda([sessao('2026-10-08', 18), sessao('2026-10-10', 18)]), '2026-10-14', h);
  assert.equal(depois.avisos_equipe.some(a => a.codigo === 'sem_agendamento'), false);
});

test('a lista por extenso', () => {
  assert.deepEqual([[], ['A'], ['A', 'B'], ['A', 'B', 'C']].map(emLista), ['', 'A', 'A e B', 'A, B e C']);
});

test('sem agendamento não olha programa com menos de 3 semanas, nem modalidade que não se agenda', () => {
  const novo = comAgenda([sessao('2026-10-08', 18)], { relatorio_aluno: { entregue_em: '2026-10-01T15:00:00Z' } });
  assert.notEqual(decidirAgenda(novo, '2026-10-13').situacao, 'sem_agendamento');
  // caminhada (sem agenda no EVO) e pilates agendado: nada a avisar
  const ok = comAgenda([sessao('2026-10-08', 18), sessao('2026-10-09', 158)]);
  assert.notEqual(decidirAgenda(ok, '2026-10-13').situacao, 'sem_agendamento');
});

test('ausência passa na frente da reavaliação e da rotina', () => {
  const f = comAgenda([sessao('2026-10-02', 18), sessao('2026-10-02', 22)], { proxima_avaliacao: '2026-10-15' });
  assert.equal(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).situacao, 'ausencia');
});


// ---- treino de musculação ----

const modelosTreino = [
  ...modelosAgenda,
  { id: 'ciclo_em_risco:todas:a', situacao: 'ciclo_em_risco', trilha: 'todas', texto: '{nome}, {treinos_ciclo} de {minimo_ciclo}.', envio: 'evo' },
  { id: 'minimo_cumprido:desafiador:a', situacao: 'minimo_cumprido', trilha: 'desafiador', texto: '{nome}, mínimo: {treinos_ciclo}.', envio: 'evo' },
  { id: 'nao_marca_app:todas:a', situacao: 'nao_marca_app', trilha: 'todas', texto: '{nome}, marca no app, {professor} agradece.', envio: 'sozinha' },
];
const treino = (inicio, validade, mudar = {}) => ({
  id: 1, inicio, validade, previstas: 32, concluidas: 3, ultima_concluida: '2026-10-09', frequencia: 4, semanas: 8,
  professor_id: 14, professor: 'MARIA SOUZA', ...mudar,
});
const decidirTreino = (f, hoje, treinos, historico = h0) =>
  decidir({ ficha: f, modelos: modelosTreino, historico, treinos, hoje, modo: 'ensaio' });
/** Presença de musculação (18) e de pilates (22) num dia — o pilates evita "modalidade sem agendamento". */
const treinou = (...dias) => dias.flatMap(d => [sessao(d, 18), sessao(d, 22)]);

test('resumir os treinos do EVO: sem os excluídos, datas sem hora, em ordem', () => {
  const r = resumirTreinos([
    { idWorkout: 2, startDate: '2026-08-09T12:40:43', expiryDate: '2026-10-18T12:40:43', totalSessions: 40, completedSessions: 15,
      lastCompletedSessionDate: '2026-10-07T11:03:24', weeklyFrequency: 4, weeklyQuantity: 10, idInstructor: 14, instructorName: 'X', isDeleted: false },
    { idWorkout: 1, startDate: '2026-05-04T00:00:00', expiryDate: null, isDeleted: false },
    { idWorkout: 3, startDate: '2026-09-01T00:00:00', isDeleted: true },
  ]);
  assert.deepEqual(r.map(x => [x.id, x.inicio, x.validade, x.ultima_concluida]),
    [[1, '2026-05-04', null, null], [2, '2026-08-09', '2026-10-18', '2026-10-07']]);
});

test('treino vigente: o último que já começou, e se está na validade', () => {
  const ts = [treino('2026-08-09', '2026-10-18'), treino('2026-11-01', '2026-12-31', { id: 2 })];
  assert.deepEqual([treinoVigente(ts, '2026-10-12').inicio, treinoVigente(ts, '2026-10-12').vigente], ['2026-08-09', true]);
  assert.equal(treinoVigente(ts, '2026-10-20').vigente, false);
  assert.equal(treinoVigente([], '2026-10-12'), null);
});

test('treino anterior ao programa não mede o ciclo, e o motivo diz isso', () => {
  const f = comAgenda(treinou('2026-10-08', '2026-10-10'), { relatorio_aluno: { entregue_em: '2026-10-07T15:00:00Z' } });
  const c = cicloDoTreino(f, [treino('2026-08-09', '2026-10-18')], leituraDaAgenda(f), '2026-10-12');
  assert.equal(c.treino, null);
  const d = decidirTreino(f, '2026-10-12', [treino('2026-08-09', '2026-10-18')]);
  assert.match(d.motivo, /Treino de musculação no EVO de 09\/08, anterior ao programa: o ciclo se confere no treino novo/);
});

test('ciclo em risco: metade do treino do ciclo com menos da metade do mínimo', () => {
  // programa desde 01/09; treino do 1º ciclo de 02/09 a 28/10 (meio em 30/09); mínimo 10; 3 treinos na agenda
  const f = comAgenda(treinou('2026-09-05', '2026-09-20', '2026-10-08'));
  const ts = [treino('2026-09-02', '2026-10-28')];
  const d = decidirTreino(f, '2026-10-12', ts);
  assert.deepEqual([d.situacao, d.texto], ['ciclo_em_risco', 'Claudia, 3 de 10.']);
  assert.match(d.motivo, /Metade do treino do 1º ciclo \(02\/09 a 28\/10\) com 3 de 10 treinos de musculação na agenda/);
  const h = [...h0, { dia: '2026-10-12', situacao: 'ciclo_em_risco', modelo_id: d.modelo_id, valores: {} }];
  assert.notEqual(decidirTreino(f, '2026-10-13', ts, h).situacao, 'ciclo_em_risco');   // uma vez por treino
});

test('na adesão, o ciclo em risco também vai à equipe', () => {
  const f = comAgenda(treinou('2026-09-05', '2026-09-20', '2026-10-08'), { trilha: { ...ficha().trilha, principal: 'adesao' } });
  const d = decidirTreino(f, '2026-10-12', [treino('2026-09-02', '2026-10-28')]);
  assert.equal(d.situacao, 'ciclo_em_risco');
  assert.match(d.avisos_equipe.map(a => a.texto).join(' '), /Metade do ciclo de musculação com 3 de 10 treinos/);
});

test('mínimo cumprido: só na trilha que tem modelo; nas outras, a situação é pulada', () => {
  const dias = ['2026-09-03', '2026-09-05', '2026-09-08', '2026-09-10', '2026-09-12', '2026-09-15', '2026-09-17', '2026-09-19', '2026-09-22', '2026-10-08'];
  const f = comAgenda(treinou(...dias));
  const ts = [treino('2026-09-02', '2026-10-28', { ultima_concluida: '2026-10-08' })];
  const d = decidirTreino(f, '2026-10-12', ts);
  assert.deepEqual([d.situacao, d.texto], ['minimo_cumprido', 'Claudia, mínimo: 10.']);
  const tecnico = comAgenda(treinou(...dias), { trilha: { ...ficha().trilha, principal: 'tecnico' } });
  assert.notEqual(decidirTreino(tecnico, '2026-10-12', ts).situacao, 'minimo_cumprido');
});

test('o n-ésimo treino do programa é o n-ésimo ciclo', () => {
  const f = comAgenda(treinou('2026-10-08'), {
    ciclos: [{ descricao: 'a', minimo_treinos: 10 }, { descricao: 'b', minimo_treinos: 20 }],
  });
  const c = cicloDoTreino(f, [treino('2026-09-02', '2026-10-01'), treino('2026-10-02', '2026-11-30', { id: 2 })], leituraDaAgenda(f), '2026-10-12');
  assert.deepEqual([c.numero, c.ciclo.minimo_treinos, c.presencas], [2, 20, 1]);
});

test('não marca no app: musculação na agenda e nada concluído no app em 14 dias', () => {
  const f = comAgenda(treinou('2026-10-02', '2026-10-06', '2026-10-09'));
  const velho = [treino('2026-08-09', '2026-10-18', { ultima_concluida: '2026-09-10' })];
  const d = decidirTreino(f, '2026-10-12', velho);
  assert.deepEqual([d.situacao, d.texto], ['nao_marca_app', 'Claudia, marca no app, Maria agradece.']);
  assert.match(d.motivo, /3 treinos de musculação na agenda de 27\/09 a 11\/10, e nenhum marcado no app \(último em 10\/09\)/);
  const marca = [treino('2026-08-09', '2026-10-18', { ultima_concluida: '2026-10-09' })];
  assert.notEqual(decidirTreino(f, '2026-10-12', marca).situacao, 'nao_marca_app');
  const h = [...h0, { dia: '2026-10-12', situacao: 'nao_marca_app', modelo_id: 'nao_marca_app:todas:a', valores: {} }];
  assert.notEqual(decidirTreino(f, '2026-10-20', velho, h).situacao, 'nao_marca_app');   // não repete em 30 dias
});

test('treino vencendo vai à equipe, sem ocupar a mensagem do dia', () => {
  const f = comAgenda(treinou('2026-10-08'));
  const ts = [treino('2026-08-09', '2026-10-18', { ultima_concluida: '2026-10-08' })];
  const d = decidirTreino(f, '2026-10-12', ts);
  assert.deepEqual(d.avisos_equipe.map(a => a.texto), ['O treino de musculação vence em 6 dia(s), em 18/10. Já monta o próximo ciclo: treino novo na hora certa mantém o embalo.']);
  assert.equal(d.status, 'nada');
  assert.deepEqual(avisosDaEquipe({ ficha: f, treinos: ts, ciclo: null, hoje: '2026-10-05', situacao: null }), []);
});

test('D3: sem professor escolhido no card, {professor} é quem prescreveu o treino', () => {
  const f = comAgenda(treinou('2026-10-02', '2026-10-06', '2026-10-09'), { professor: { origem: 'avaliador', nome: 'Vanessa Robert' } });
  const velho = [treino('2026-08-09', '2026-10-18', { ultima_concluida: '2026-09-10' })];
  assert.equal(decidirTreino(f, '2026-10-12', velho).texto, 'Claudia, marca no app, Maria agradece.');
  const card = comAgenda(treinou('2026-10-02', '2026-10-06', '2026-10-09'), { professor: { origem: 'card', nome: 'Vanessa Robert' } });
  assert.equal(decidirTreino(card, '2026-10-12', velho).texto, 'Claudia, marca no app, Vanessa agradece.');
});

test('treino vencido sem treino novo segue avisando a equipe por 14 dias', () => {
  const f = comAgenda(treinou('2026-10-08'));
  const ts = [treino('2026-08-09', '2026-10-18', { ultima_concluida: '2026-10-08' })];
  assert.deepEqual(decidirTreino(f, '2026-10-19', ts).avisos_equipe.map(a => a.texto), ['O treino de musculação venceu em 18/10 e o próximo ainda não está no EVO. Monta o novo ciclo e apresenta no próximo treino: novidade puxa a vontade de vir.']);
  assert.deepEqual(decidirTreino(f, '2026-11-01', ts).avisos_equipe.map(a => a.texto), ['O treino de musculação venceu em 18/10 e o próximo ainda não está no EVO. Monta o novo ciclo e apresenta no próximo treino: novidade puxa a vontade de vir.']);
  assert.deepEqual(decidirTreino(f, '2026-11-02', ts).avisos_equipe.map(a => a.texto), []);   // 15 dias depois
  // com o treino novo criado, o aviso some
  assert.deepEqual(decidirTreino(f, '2026-10-20', [...ts, treino('2026-10-20', '2026-12-15', { id: 2 })]).avisos_equipe, []);
});

test('cada aviso à equipe leva código, urgência e referência, para virar um encaminhamento só', () => {
  const f = comAgenda(treinou('2026-10-08'));
  const ts = [treino('2026-08-09', '2026-10-18', { id: 32116, ultima_concluida: '2026-10-08' })];
  const [a] = decidirTreino(f, '2026-10-12', ts).avisos_equipe;
  assert.deepEqual([a.codigo, a.urgencia, a.referencia, a.motivo], ['treino_vencendo', 'proximos_dias', '32116', 'treino de musculação vencendo']);
});

test('D6: ausência na adesão também avisa o professor', () => {
  const f = comAgenda([], { trilha: { ...ficha().trilha, principal: 'adesao' } });
  const d = decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 10));
  assert.equal(d.situacao, 'ausencia');
  assert.deepEqual(d.avisos_equipe.map(a => [a.codigo, a.referencia]), [['ausencia_adesao', '2026-10-12']]);
  assert.match(d.avisos_equipe[0].texto, /10 dias sem vir/);
  // fora da adesão, a ausência não vai à equipe
  assert.deepEqual(decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-12', 10)).avisos_equipe, []);
});

// ---- as fases da ficha (v4, M1 do PLANO_MODELOS) ----

/** O comportamento como o Prescrev o publica: início 14/09, semana 6, N1, em dia. Dados até 19/10. */
const comportamento = (mudar = {}) => ({
  versao: 1, ate: '2026-10-19', desde: '2026-09-08', inicio: '2026-09-14', semana: 6, semanas: [3, 3, 3, 3, 3],
  presencas: { d7: 3, d14: 6, d28: 12, semanas_ativas_4: 4, ultima: '2026-10-17', primeira_apos_entrega: '2026-09-14' },
  razao_cumprida: 1, dias_sem_vir: 2, sessoes_na_agenda: 12, periodo_habitual: 'manhã', regular: false,
  fase: { valor: 'inicio', pelo_tempo: 'inicio', teto_mensagens: 2, teto_dias: 7, cadencia_dias: 3, lembrete_agendamento: false,
    ativacao_dias: null, retornou_em: null, motivo: 'Semana 6 desde 2026-09-14 (a primeira presença).' },
  degrau: { valor: 1, teto: 2, trajetoria: [0, 0, 0, 1, 1], numero_em: null, motivo: '…' },
  ausencia: { etapa: 'presente', responsavel: 'leia', desde: '2026-10-17', prazos: { aviso: 10, professor: 14, silencio: 21, consultor: 30, porta_aberta: 30 } },
  ...mudar,
});
const comFases = (mudar = {}, fichaMudar = {}) => ficha({ versao: 4, comportamento: comportamento(mudar), ...fichaMudar });

test('fases da ficha: nada sem comportamento; com ele, fase, degrau, cadência, teto e ausência', () => {
  assert.equal(fasesDaFicha(ficha()), null);
  assert.deepEqual(fasesDaFicha(comFases()),
    { fase: 'inicio', degrau: 1, cadencia: 3, teto: { mensagens: 2, dias: 7 }, ausencia: 'presente', ausenciaDesde: '2026-10-17', ate: '2026-10-19',
      ativacao: null, ativacaoDias: null, lembreteAgendamento: false, periodo: 'manhã', semana: 6 });
});

test('a cadência é a da fase, e a decisão leva fase e degrau', () => {
  const h = [{ dia: '2026-10-17', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const d = decidirEm('2026-10-20', h, comFases());   // trilha 14, fase 3
  assert.deepEqual([d.situacao, d.fase, d.degrau], ['rotina', 'inicio', 1]);
  assert.match(d.motivo, /cadência de 3 \(fase inicio, degrau N1\)/);
  assert.equal(decidirEm('2026-10-19', h, comFases()).status, 'nada');
  // sem comportamento, a da trilha, e a decisão não tem fase
  assert.deepEqual([decidirEm('2026-10-20', h).status, decidirEm('2026-10-20', h).fase], ['nada', null]);
});

test('na ativação não há rotina, e o motivo diz por quê', () => {
  const h = [{ dia: '2026-10-01', situacao: 'boas_vindas', modelo_id: 'x' }];
  const ativacao = comFases({ fase: { ...comportamento().fase, valor: 'ativacao', pelo_tempo: 'ativacao', cadencia_dias: null,
    motivo: 'Relatório entregue em 2026-10-01, sem presença depois.' } });
  const d = decidirEm('2026-10-20', h, ativacao);
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /Sem rotina na fase ativacao: Relatório entregue em 2026-10-01/);
});

test('teto da fase: alcançado, a rotina devida não sai; passada a janela, sai', () => {
  const consolidacao = comFases({ fase: { ...comportamento().fase, valor: 'consolidacao', teto_mensagens: 1, teto_dias: 7, cadencia_dias: 5 } });
  const h = [{ dia: '2026-10-14', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const d = decidirEm('2026-10-20', h, consolidacao);   // 6 dias: devida (5), mas 1 em 7 dias
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /Rotina devida \(6 dia\(s\), cadência de 5 \(fase consolidacao, degrau N1\)\) e não sai: teto da fase consolidacao alcançado \(1 em 7 dias\)/);
  assert.equal(decidirEm('2026-10-21', h, consolidacao).situacao, 'rotina');
});

test('uma situação na semana segura a rotina; passada a semana, sai', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }, { dia: '2026-10-16', situacao: 'reavaliacao', modelo_id: 'y' }];
  const d = decidirEm('2026-10-20', h, comFases());
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /já saiu reavaliacao em 16\/10, e uma situação na semana segura a rotina/);
  assert.equal(decidirEm('2026-10-23', h, comFases()).situacao, 'rotina');
});

test('o aluno respondeu hoje ou ontem: a rotina espera 48 h', () => {
  const h = [{ dia: '2026-10-10', situacao: 'rotina', modelo_id: 'x' }];
  const ontem = decidir({ ficha: comFases(), modelos, historico: h, hoje: '2026-10-20', modo: 'ensaio', ultimaResposta: '2026-10-19' });
  assert.equal(ontem.status, 'nada');
  assert.match(ontem.motivo, /o aluno respondeu em 19\/10, e a rotina espera 48 h/);
  assert.equal(decidir({ ficha: comFases(), modelos, historico: h, hoje: '2026-10-20', modo: 'ensaio', ultimaResposta: '2026-10-18' }).situacao, 'rotina');
});

test('em silêncio nada vai ao aluno: nem rotina, nem reavaliação', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const silencio = comFases(
    { dias_sem_vir: 24, ausencia: { ...comportamento().ausencia, etapa: 'silencio', responsavel: 'professor', desde: '2026-09-25' } },
    { proxima_avaliacao: '2026-10-25' });
  const d = decidirEm('2026-10-20', h, silencio);
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /não sai: ausência em silêncio \(dados de 19\/10\), nada ao aluno até a próxima presença/);
});

const modelosPorta = [...modelos,
  { id: 'porta_aberta:todas:a', situacao: 'porta_aberta', trilha: 'todas', texto: '{nome}, sua vaga continua aqui.', envio: 'sozinha' }];

test('porta aberta: uma vez por ausência, com modelo; depois, silêncio até a próxima presença', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const porta = comFases({ dias_sem_vir: 31, ausencia: { ...comportamento().ausencia, etapa: 'porta_aberta', responsavel: 'consultor', desde: '2026-09-18' } });
  const d = decidir({ ficha: porta, modelos: modelosPorta, historico: h, hoje: '2026-10-20', modo: 'ensaio' });
  assert.deepEqual([d.situacao, d.texto], ['porta_aberta', 'Claudia, sua vaga continua aqui.']);
  assert.match(d.motivo, /Porta aberta: sem vir desde 18\/09 \(dados de 19\/10\)/);
  const depois = [...h, { dia: '2026-10-20', situacao: 'porta_aberta', modelo_id: 'porta_aberta:todas:a' }];
  const calada = decidir({ ficha: porta, modelos: modelosPorta, historico: depois, hoje: '2026-10-25', modo: 'ensaio' });
  assert.equal(calada.status, 'nada');
  assert.match(calada.motivo, /ausência em porta aberta \(dados de 19\/10\), nada ao aluno/);
  // sem o modelo (até a M2), a situação é pulada e a rotina continua calada
  const semModelo = decidir({ ficha: porta, modelos, historico: h, hoje: '2026-10-20', modo: 'ensaio' });
  assert.equal(semModelo.status, 'nada');
  assert.match(semModelo.motivo, /porta aberta/);
});

test('o retorno passa mesmo em silêncio: a agenda diz que a pessoa voltou', () => {
  const h = [...h0, { dia: '2026-10-12', situacao: 'ausencia', modelo_id: 'x', valores: {} }];
  const agenda = { sincronizada_em: '2026-10-18T05:10:00Z', sessoes: [sessao('2026-10-03', 18), sessao('2026-10-16', 22)] };
  const f = comAgenda([], { agenda, comportamento: comportamento({ ausencia: { ...comportamento().ausencia, etapa: 'silencio' } }) });
  assert.equal(decidirAgenda(f, '2026-10-19', h).situacao, 'retorno');
});

test('a rotina escolhe o modelo do degrau quando há, e os genéricos quando não há', () => {
  const porDegrau = [...modelos,
    { id: 'rotina:desafiador:n1', situacao: 'rotina', trilha: 'desafiador', degrau: 1, texto: '{nome}, a semana apertou?', envio: 'sozinha' },
    { id: 'rotina:desafiador:n2-inicio', situacao: 'rotina', trilha: 'desafiador', degrau: 2, fase: 'inicio', texto: '{nome}, {frequencia} no ritmo.', envio: 'sozinha' },
  ];
  const genericos = ['rotina:desafiador:a', 'rotina:desafiador:b', 'rotina:desafiador:c'];
  assert.deepEqual(candidatosDe(porDegrau, 'rotina', 'desafiador', { fase: 'inicio', degrau: 1 }).map(m => m.id), ['rotina:desafiador:n1']);
  assert.deepEqual(candidatosDe(porDegrau, 'rotina', 'desafiador', { fase: 'inicio', degrau: 2 }).map(m => m.id), ['rotina:desafiador:n2-inicio']);
  // N2 na consolidação: o modelo é só do início, e não serve; ficam os genéricos
  assert.deepEqual(candidatosDe(porDegrau, 'rotina', 'desafiador', { fase: 'consolidacao', degrau: 2 }).map(m => m.id), genericos);
  assert.deepEqual(candidatosDe(porDegrau, 'rotina', 'desafiador').map(m => m.id), genericos);
  const h = [{ dia: '2026-10-10', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidir({ ficha: comFases(), modelos: porDegrau, historico: h, hoje: '2026-10-20', modo: 'ensaio' }).texto, 'Claudia, a semana apertou?');
});

test('a prioridade conhece a porta aberta, entre o retorno e o ciclo em risco', () => {
  assert.ok(PRIORIDADE.retorno < PRIORIDADE.porta_aberta && PRIORIDADE.porta_aberta < PRIORIDADE.ciclo_em_risco);
});

// ---- a M2 do PLANO_MODELOS: situações novas, marcadores das sessões, camadas ----
// 19/10/2026 é segunda; 20/10, terça; 21/10, quarta. O comportamento é de 19/10.

test('a prioridade conhece as situações da M2: o resultado antes da reavaliação; os empurrões antes da rotina', () => {
  assert.ok(PRIORIDADE.resultado_reavaliacao < PRIORIDADE.reavaliacao);
  assert.ok(PRIORIDADE.minimo_cumprido < PRIORIDADE.primeira_ida && PRIORIDADE.primeira_ida < PRIORIDADE.lembrete_agendamento);
  assert.ok(PRIORIDADE.lembrete_agendamento < PRIORIDADE.sem_agendamento && PRIORIDADE.nao_marca_app < PRIORIDADE.rotina);
});

test('preencher: o que parece marcador e não é (dígito, maiúscula) não sai cru', () => {
  assert.deepEqual(preencher('{nome}, {presencas_14} treinos.', { nome: 'Ana' }), { texto: null, faltam: ['presencas_14'] });
  assert.deepEqual(preencher('{Nome}, oi.', { nome: 'Ana' }), { texto: null, faltam: ['Nome'] });
  assert.equal(horaPorExtenso('07:00'), 'às 7h');
  assert.equal(horaPorExtenso('18:30:00'), 'às 18h30');
  assert.equal(horaPorExtenso(null), null);
});

test('marcadores das sessões: só com a carga de até 2 dias, e as contagens de 2 para cima', () => {
  const f = comFases({ presencas: { ...comportamento().presencas, d14: 6, d28: 1, semanas_ativas_4: 4 } }, {
    agenda: { sincronizada_em: '2026-10-19T08:10:00Z', sessoes: [
      sessao('2026-10-19', 18), { ...sessao('2026-10-21', 22, { finalizada: false }), hora: '18:30:00' },
    ] },
  });
  const v = valoresDaFicha(f, '2026-10-20');
  assert.deepEqual([v.presencas_quinzena, v.presencas_mes, v.semanas_ativas, v.dia, v.hora_combinada], ['6', null, '4', 'amanhã', 'às 18h30']);
  // depois de amanhã: o dia por extenso, com a preposição
  assert.equal(valoresDaFicha(f, '2026-10-19').dia, 'na quarta, 21/10');
  // carga de 3 dias: nada das sessões
  const velho = valoresDaFicha(f, '2026-10-22');
  assert.deepEqual([velho.presencas_quinzena, velho.semanas_ativas, velho.dia, velho.hora_combinada], [null, null, null, null]);
  // sem comportamento nem agenda: nada, e o resto da ficha continua
  assert.deepEqual([valoresDaFicha(ficha(), '2026-10-20').presencas_quinzena, valoresDaFicha(ficha(), '2026-10-20').nome], [null, 'Claudia']);
});

test('camadas da rotina: a da fase e do degrau, depois a do degrau; o rodízio é dentro da camada', () => {
  const porFase = [...modelos,
    { id: 'n1', situacao: 'rotina', trilha: 'desafiador', degrau: 1, fase: null, texto: '{nome}, N1.', envio: 'sozinha' },
    { id: 'n1-ret-a', situacao: 'rotina', trilha: 'desafiador', degrau: 1, fase: 'retorno', texto: '{nome}, volta {marca}.', envio: 'nao' },
    { id: 'n1-ret-b', situacao: 'rotina', trilha: 'desafiador', degrau: 1, fase: 'retorno', texto: '{nome}, volta {hora_combinada}.', envio: 'evo' },
  ];
  assert.deepEqual(camadasDe(porFase, 'rotina', 'desafiador', { fase: 'retorno', degrau: 1 }).map(c => c.map(m => m.id)),
    [['n1-ret-a', 'n1-ret-b'], ['n1']]);
  assert.deepEqual(candidatosDe(porFase, 'rotina', 'desafiador', { fase: 'inicio', degrau: 1 }).map(m => m.id), ['n1']);
  // no retorno, os dois da fase sem valor ({marca} sem fonte; {hora_combinada} sem agenda): cai no do degrau
  const retorno = comFases({ fase: { ...comportamento().fase, valor: 'retorno', cadencia_dias: 7 } });
  const h = [{ dia: '2026-10-10', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidir({ ficha: retorno, modelos: porFase, historico: h, hoje: '2026-10-20', modo: 'ensaio' }).texto, 'Claudia, N1.');
});

/** Uma ficha na ativação: relatório entregue em 16/10, sem ida, 3 dias abertos na carga de 19/10. */
const ativacao = (mudar = {}) => comFases({
  inicio: null, semana: null, semanas: [], dias_sem_vir: 3,
  fase: { ...comportamento().fase, valor: 'ativacao', pelo_tempo: 'ativacao', cadencia_dias: null, ativacao_dias: 3,
    ativacao_etapa: 'lembrete', motivo: 'Relatório entregue em 2026-10-16, sem presença depois.' },
  degrau: { valor: 0, teto: 0, trajetoria: [], numero_em: null, motivo: 'Na ativação, N0.' },
  ...mudar,
}, { relatorio_aluno: { entregue_em: '2026-10-16T15:00:00Z' } });
const modelosAtivacao = [...modelos,
  { id: 'primeira_ida:desafiador:a', situacao: 'primeira_ida', trilha: 'desafiador', texto: '{nome}, qual dia fica bom pro primeiro treino?', envio: 'sozinha' }];
const hBoasVindas = [{ dia: '2026-10-17', situacao: 'boas_vindas', modelo_id: 'b' }];
const naAtivacao = (f, hoje, historico = hBoasVindas) => decidir({ ficha: f, modelos: modelosAtivacao, historico, hoje, modo: 'ensaio' });

test('primeira ida: no 3º dia sem ida, uma vez por entrega', () => {
  const d = naAtivacao(ativacao(), '2026-10-20');
  assert.deepEqual([d.situacao, d.texto], ['primeira_ida', 'Claudia, qual dia fica bom pro primeiro treino?']);
  assert.match(d.motivo, /3 dia\(s\) desde a entrega do relatório sem presença na agenda \(dados de 19\/10\)/);
  const depois = [...hBoasVindas, { dia: '2026-10-20', situacao: 'primeira_ida', modelo_id: 'primeira_ida:desafiador:a' }];
  assert.equal(naAtivacao(ativacao(), '2026-10-21', depois).status, 'nada');
  // ainda no prazo: nada
  assert.equal(naAtivacao(ativacao({ fase: { ...ativacao().comportamento.fase, ativacao_dias: 2, ativacao_etapa: 'aguardando' } }), '2026-10-20').status, 'nada');
});

test('primeira ida: espera a carga do dia, e não sai no dia seguinte a outra mensagem', () => {
  const velha = naAtivacao(ativacao(), '2026-10-22');
  assert.equal(velha.status, 'nada');
  assert.match(velha.motivo, /Lembrete da primeira ida devido, e os dados são de 19\/10: espera a carga do dia/);
  const ontem = naAtivacao(ativacao(), '2026-10-20', [{ dia: '2026-10-19', situacao: 'boas_vindas', modelo_id: 'b' }]);
  assert.equal(ontem.status, 'nada');
  assert.match(ontem.motivo, /Lembrete da primeira ida devido, e não sai: já saiu boas_vindas em 19\/10/);
});

test('nunca veio: no 7º dia sem ida, nada ao aluno e o aviso ao professor, um por entrega', () => {
  const nunca = ativacao({ fase: { ...ativacao().comportamento.fase, ativacao_dias: 7, ativacao_etapa: 'nunca_veio' } });
  const d = naAtivacao(nunca, '2026-10-20');
  assert.equal(d.status, 'nada');
  assert.deepEqual(d.avisos_equipe.map(a => [a.codigo, a.referencia, a.urgencia]), [['nunca_veio', '2026-10-16', 'proximos_dias']]);
  assert.match(d.avisos_equipe[0].texto, /7 dias desde a entrega do relatório \(16\/10\) sem presença na agenda \(dados de 19\/10\)/);
  // com a carga velha, não avisa: quem veio depois dela seria cobrado à toa
  assert.deepEqual(naAtivacao(nunca, '2026-10-23').avisos_equipe, []);
});

const modelosLembrete = [...modelos,
  { id: 'lembrete_agendamento:desafiador:a', situacao: 'lembrete_agendamento', trilha: 'desafiador', texto: '{nome}, já agendou os treinos desta semana?', envio: 'sozinha' }];
/** Semana 2 do início, com o lembrete de agendamento; a agenda carregada na terça 20/10, sem nada na semana. */
const noInicio = (mudar = {}, fichaMudar = {}) => comFases(
  { semana: 2, fase: { ...comportamento().fase, lembrete_agendamento: true }, ...mudar },
  { agenda: { sincronizada_em: '2026-10-20T08:10:00Z', sessoes: [sessao('2026-10-16', 18)] }, ...fichaMudar });
const hLembrete = [{ dia: '2026-10-18', situacao: 'rotina', modelo_id: 'x' }];
const lembrar = (f, hoje) => decidir({ ficha: f, modelos: modelosLembrete, historico: hLembrete, hoje, modo: 'ensaio' });

test('lembrete de agendamento: na terça, nada na semana, sai de tarde para quem treina de manhã', () => {
  const d = lembrar(noInicio(), '2026-10-20');
  assert.deepEqual([d.situacao, d.periodo_envio, d.texto], ['lembrete_agendamento', 'tarde', 'Claudia, já agendou os treinos desta semana?']);
  assert.match(d.motivo, /nada agendado de 19\/10 a 25\/10 \(agenda de 20\/10\)\. Treina de manhã: o lembrete sai na terça, de tarde/);
  // na segunda não é o dia
  assert.notEqual(lembrar(noInicio(), '2026-10-19').situacao, 'lembrete_agendamento');
  // fora das 3 primeiras semanas a ficha não pede
  assert.notEqual(lembrar(comFases({}, { agenda: noInicio().agenda }), '2026-10-20').situacao, 'lembrete_agendamento');
});

test('lembrete de agendamento: quem treina à noite recebe na quarta, de manhã', () => {
  const noite = noInicio({ periodo_habitual: 'noite' }, { agenda: { sincronizada_em: '2026-10-21T08:10:00Z', sessoes: [] } });
  assert.notEqual(lembrar(noite, '2026-10-20').situacao, 'lembrete_agendamento');
  const d = lembrar(noite, '2026-10-21');
  assert.deepEqual([d.situacao, d.periodo_envio], ['lembrete_agendamento', 'manhã']);
  assert.match(d.motivo, /sai na quarta, de manhã/);
  // sem período habitual, vale o declarado
  const declarado = noInicio({ periodo_habitual: null }, { marcadores: { ...ficha().marcadores, periodo: 'tarde' } });
  assert.equal(lembrar(declarado, '2026-10-20').periodo_envio, 'noite');
});

test('lembrete de agendamento: com treino agendado na semana, ou a agenda de ontem, não sai', () => {
  const agendado = noInicio({}, { agenda: { sincronizada_em: '2026-10-20T08:10:00Z', sessoes: [sessao('2026-10-24', 18, { finalizada: false })] } });
  assert.notEqual(lembrar(agendado, '2026-10-20').situacao, 'lembrete_agendamento');
  const ontem = lembrar(noInicio({}, { agenda: { sincronizada_em: '2026-10-19T08:10:00Z', sessoes: [] } }), '2026-10-20');
  assert.notEqual(ontem.situacao, 'lembrete_agendamento');
  assert.match(ontem.motivo, /Lembrete de agendamento devido, e a agenda é de 19\/10: espera a agenda do dia/);
});

test('hora prevista: o período de envio passa por cima do preferido', () => {
  const tarde = horaPrevista(ficha(), '2026-10-08', SEMANA, 'tarde');
  assert.ok(minutoSP(tarde) >= 14 * 60 && minutoSP(tarde) <= 14 * 60 + 40, minutoSP(tarde));
});

test('resultado da reavaliação: até 7 dias depois do relatório, uma vez', () => {
  const comResultado = [...modelos,
    { id: 'resultado_reavaliacao:todas:a', situacao: 'resultado_reavaliacao', trilha: 'todas', texto: '{nome}, o resultado está pronto.', envio: 'sozinha' }];
  const f = comFases({}, { reavaliacao_pronta_em: '2026-10-18' });
  const h = [{ dia: '2026-10-10', situacao: 'rotina', modelo_id: 'x' }];
  const em = (hoje, historico = h) => decidir({ ficha: f, modelos: comResultado, historico, hoje, modo: 'ensaio' });
  const d = em('2026-10-20');
  assert.deepEqual([d.situacao, d.texto], ['resultado_reavaliacao', 'Claudia, o resultado está pronto.']);
  assert.match(d.motivo, /Relatório da reavaliação gerado em 18\/10/);
  assert.notEqual(em('2026-10-26').situacao, 'resultado_reavaliacao');
  assert.notEqual(em('2026-10-21', [...h, { dia: '2026-10-20', situacao: 'resultado_reavaliacao', modelo_id: 'x' }]).situacao, 'resultado_reavaliacao');
});

test('camadas da rotina: no início, a semana passa na frente da fase e do degrau; fora da janela, não vale', () => {
  const porSemana = [...modelos,
    { id: 's12', situacao: 'rotina', trilha: 'desafiador', degrau: null, fase: 'inicio', semanas: [1, 2], texto: '{nome}, semanas 1 e 2.', envio: 'sozinha' },
    { id: 's56', situacao: 'rotina', trilha: 'desafiador', degrau: null, fase: 'inicio', semanas: [5, 6], texto: '{nome}, semanas 5 e 6.', envio: 'sozinha' },
    { id: 'n1', situacao: 'rotina', trilha: 'desafiador', degrau: 1, fase: null, semanas: null, texto: '{nome}, N1.', envio: 'sozinha' },
    { id: 'cons', situacao: 'rotina', trilha: 'desafiador', degrau: null, fase: 'consolidacao', semanas: null, texto: '{nome}, consolidação.', envio: 'sozinha' },
  ];
  const ids = (onde) => camadasDe(porSemana, 'rotina', 'desafiador', onde).map(c => c.map(m => m.id));
  assert.deepEqual(ids({ fase: 'inicio', degrau: 1, semana: 6 }), [['s56'], ['n1']]);
  assert.deepEqual(ids({ fase: 'inicio', degrau: 1, semana: 2 }), [['s12'], ['n1']]);
  // semana 3: nenhuma janela casa; vale o degrau
  assert.deepEqual(ids({ fase: 'inicio', degrau: 1, semana: 3 }), [['n1']]);
  // a fase sem degrau vale em qualquer degrau, e passa na frente do degrau
  assert.deepEqual(ids({ fase: 'consolidacao', degrau: 1, semana: 8 }), [['cons'], ['n1']]);
  // e a régua passa a semana da ficha: semana 6 do início
  const h = [{ dia: '2026-10-10', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidir({ ficha: comFases(), modelos: porSemana, historico: h, hoje: '2026-10-20', modo: 'ensaio' }).texto, 'Claudia, semanas 5 e 6.');
});

// ---- M3: as condutas ao professor -------------------------------------
const CATALOGO = [
  { codigo: 'semana_1', sinal: 'primeira semana do programa', destino: 'professor', gatilho: 'ficha', carga_do_dia: false,
    texto: 'Combina com {nome} o treino mínimo.' },
  { codigo: 'ausencia_professor', sinal: 'ausência', destino: 'professor', gatilho: 'ficha', carga_do_dia: true,
    texto: '{nome} está há {dias} dias sem vir.' },
  { codigo: 'ausencia_consultor', sinal: 'ausência longa', destino: 'consultor', gatilho: 'ficha', carga_do_dia: true,
    texto: '{nome} está há {dias} dias sem vir, e o caso passa a você.' },
  { codigo: 'barreira_horario', sinal: 'barreira', destino: 'professor', gatilho: 'professor', carga_do_dia: false,
    texto: 'Oferece outro dia a {nome}.' },
  { codigo: 'ciclo_em_risco', sinal: 'ciclo em risco', destino: 'professor', gatilho: 'regua', carga_do_dia: false,
    texto: 'Pergunta a {nome} o que está atrapalhando.' },
];
const avisosCom = (fichaMudar, hoje = '2026-10-20', extra = {}) =>
  avisosDaEquipe({ ficha: comFases({}, fichaMudar), treinos: [], ciclo: null, hoje, situacao: null, condutas: CATALOGO, ...extra });

test('conduta da ficha vira aviso com o texto do catálogo, uma vez por referência', () => {
  const a = avisosCom({ condutas: [{ codigo: 'semana_1', referencia: '2026-10-14' }] });
  assert.deepEqual(a.map(x => [x.codigo, x.referencia, x.motivo, x.conduta, x.destino]),
    [['semana_1', '2026-10-14', 'primeira semana do programa', 'Combina com Claudia o treino mínimo.', 'professor']]);
  assert.equal(a[0].texto, a[0].conduta);
});

test('conduta de ausência só com a carga de hoje ou de ontem, e com os dias preenchidos', () => {
  const c = [{ codigo: 'ausencia_professor', referencia: '2026-10-05' }];
  const fresca = avisosCom({ condutas: c, comportamento: comportamento({ ate: '2026-10-19', dias_sem_vir: 14 }) });
  assert.deepEqual(fresca.map(x => x.texto), ['Claudia está há 14 dias sem vir.']);
  const velha = avisosCom({ condutas: c, comportamento: comportamento({ ate: '2026-10-15', dias_sem_vir: 14 }) });
  assert.deepEqual(velha, []);
});

test('conduta ao consultor leva o destino; a do professor sem gatilho de ficha não sai; sem catálogo, nada', () => {
  const a = avisosCom({ condutas: [{ codigo: 'ausencia_consultor', referencia: '2026-09-15' }, { codigo: 'barreira_horario', referencia: 'x' }],
    comportamento: comportamento({ dias_sem_vir: 30 }) });
  assert.deepEqual(a.map(x => [x.codigo, x.destino]), [['ausencia_consultor', 'consultor']]);
  assert.deepEqual(avisosCom({ condutas: [{ codigo: 'semana_1', referencia: 'r' }] }, '2026-10-20', { condutas: [] }), []);
});

test('a conduta de gatilho da régua vai junto do aviso que já existia (ciclo em risco)', () => {
  const f = comFases({}, { trilha: { ...ficha().trilha, principal: 'adesao' } });
  const a = avisosDaEquipe({ ficha: f, treinos: [], hoje: '2026-10-20', situacao: 'ciclo_em_risco', condutas: CATALOGO,
    ciclo: { treino: { id: 1 }, presencas: 3, ciclo: { minimo_treinos: 10 } } });
  const ciclo = a.find(x => x.codigo === 'ciclo_em_risco');
  assert.equal(ciclo.conduta, 'Pergunta a Claudia o que está atrapalhando.');
  assert.match(ciclo.texto, /^Metade do ciclo de musculação com 3 de 10 treinos/);
});
