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
import { diasEntre, preencher, valoresDaFicha } from './render.js';
import {
  avisosDaEquipe, candidatosDe, cicloDoTreino, decidir, diaPorExtenso, emLista, emRodizio, horaPrevista, resumirTreinos, treinoVigente, leituraDaAgenda, limiteAusencia, modalidadesNaAgenda, situacaoDoDia,
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

test('no envio a decisão fica pendente, e não simulada', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidirEm('2026-10-20', h, ficha(), 'envio').status, 'pendente');
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

test('limite de ausência pela frequência: o maior entre 5 e 14 ÷ frequência', () => {
  assert.deepEqual([1, 2, 3, 5, null].map(limiteAusencia), [14, 7, 5, 5, 14]);
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
const semPresenca = comAgenda([sessao('2026-10-03', 18), sessao('2026-10-03', 22)]);

test('ausência pelo aviso do EVO, acima do limite, com {dias}', () => {
  const d = decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-12', 8));
  assert.deepEqual([d.situacao, d.texto], ['ausencia', 'Claudia, 8 dias sem treino.']);
  assert.match(d.motivo, /Aviso "Sem presença" do EVO em 12\/10: 8 dias; limite de 5 para 3× por semana/);
});

test('sem aviso do EVO não há ausência — a agenda semanal sozinha não decide', () => {
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-12').situacao, 'ausencia');
});

test('aviso abaixo do limite da frequência não conta', () => {
  const duas = comAgenda([], { frequencia: { dias_semana: 2, fonte: 'prescricao' } });
  assert.notEqual(decidirAgenda(duas, '2026-10-12', h0, avisoEVO('2026-10-12', 5)).situacao, 'ausencia');
  assert.equal(decidirAgenda(duas, '2026-10-12', h0, avisoEVO('2026-10-12', 7)).situacao, 'ausencia');
});

test('aviso de mais de 2 dias não vira mensagem', () => {
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-09', 8)).situacao, 'ausencia');
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
  const d = decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 8));
  assert.equal(d.status, 'nada');
  assert.match(d.motivo, /Aviso "Sem presença" do EVO de 12\/10 contradito pela agenda \(presença em 09\/10\): não sai/);
});

test('aula ainda não finalizada não contradiz o aviso', () => {
  const f = comAgenda([sessao('2026-10-09', 18, { finalizada: false })]);
  assert.equal(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 8)).situacao, 'ausencia');
});

test('uma mensagem por aviso', () => {
  const h = [...h0, { dia: '2026-10-12', situacao: 'ausencia', modelo_id: 'ausencia:desafiador:a', valores: { dias: '8' } }];
  assert.notEqual(decidirAgenda(semPresenca, '2026-10-13', h, avisoEVO('2026-10-12', 8)).situacao, 'ausencia');
});

test('na adesão, o motivo lembra que o professor recebe o aviso junto (D6)', () => {
  const f = comAgenda([], { trilha: { ...ficha().trilha, principal: 'adesao' } });
  assert.match(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 8)).motivo, /professor recebe o aviso junto \(D6/);
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
  const f = comAgenda([sessao('2026-10-03', 18), sessao('2026-10-03', 22)], { proxima_avaliacao: '2026-10-15' });
  assert.equal(decidirAgenda(f, '2026-10-12', h0, avisoEVO('2026-10-12', 8)).situacao, 'ausencia');
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
  assert.match(d.avisos_equipe.map(a => a.texto).join(' '), /Ciclo em risco na trilha de adesão: 3 de 10/);
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
  assert.deepEqual(d.avisos_equipe.map(a => a.texto), ['Treino de musculação vence em 6 dia(s), em 18/10: prescrever o ciclo seguinte.']);
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
  assert.deepEqual(decidirTreino(f, '2026-10-19', ts).avisos_equipe.map(a => a.texto), ['Treino de musculação vencido desde 18/10, sem treino novo no EVO.']);
  assert.deepEqual(decidirTreino(f, '2026-11-01', ts).avisos_equipe.map(a => a.texto), ['Treino de musculação vencido desde 18/10, sem treino novo no EVO.']);
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
  assert.deepEqual(decidirAgenda(semPresenca, '2026-10-12', h0, avisoEVO('2026-10-12', 8)).avisos_equipe, []);
});
