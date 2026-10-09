/**
 * Testes dos comandos da equipe. Puros, sem `.env`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acompanhamentoDaFicha, combinadoDaFicha, coordenadorDePlantao, destinoDoAluno, lerComandoEquipe, lerRespostaDoBriefing,
  rotear, textoDaResposta, textoDeConfirmacao, textoDoBriefing, lerComandoAtivar, mesmoNumero, textoDoAceite, cadenciaPorExtenso,
} from './comandos.js';

test('o comando EQUIPE, com espaços e caixa à vontade', () => {
  assert.deepEqual(['EQUIPE K7P2QX', 'equipe k7p2qx', '  Equipe  K7P 2QX  '].map(lerComandoEquipe),
    ['K7P2QX', 'K7P2QX', 'K7P2QX']);
});

test('cara de comando com código fora do formato: a resposta ensina', () => {
  // 0, O, 1 e I não existem no alfabeto; 4 a 10 caracteres têm cara de código
  assert.deepEqual(['EQUIPE K7P2Q0', 'EQUIPE 1234', 'equipe ABCDEFGH'].map(lerComandoEquipe), ['', '', '']);
});

test('mensagem de cliente que começa com "equipe" não é comando', () => {
  assert.deepEqual([
    'Equipe de natação tem vaga?', 'equipe top', 'EQUIPE', 'Equipe', 'a equipe K7P2QX', 'equipe de vocês é ótima',
    'EQUIPE K7P2QX obrigado pela ajuda',
  ].map(lerComandoEquipe), [null, null, null, null, null, null, null]);
});

test('a confirmação diz o horário, e ao coordenador que ele também recebe o que não for assumido', () => {
  const horario = { 1: [['06:00', '10:00']] };
  assert.match(textoDeConfirmacao({ nome: 'Rafael', papel: 'professor', horario }),
    /^Pronto, Rafael: os encaminhamentos dos seus alunos chegam aqui, só no seu horário de trabalho\. Em teste/);
  assert.match(textoDeConfirmacao({ nome: 'Ana', papel: 'coordinator', horario }),
    /Como coordenação, você também recebe os que o professor não assumir/);
  assert.match(textoDeConfirmacao({ nome: 'Rafael', papel: 'professor', horario: null }),
    /Ainda não há horário de trabalho seu no Prescrev: até a coordenação cadastrar, nenhum encaminhamento chega/);
  assert.doesNotMatch(textoDeConfirmacao({ nome: 'Leo', papel: 'master', horario }), /coordenação/);
});

// ---- encaminhamentos ----

const fichaB = {
  aluno: { primeiro_nome: 'Claudia', idade: 56 },
  frequencia: { dias_semana: 5 },
  modalidades: [{ nome: 'Musculação' }, { nome: 'Mat Pilates' }],
  trilha: { principal: 'desafiador', secundaria: 'tecnico' },
  proxima_avaliacao: '2026-11-21',
  professor: { profile_id: 'p-aval', nome: 'VANESSA ROBERT', origem: 'avaliador' },
};
const equipeB = [
  { profile_id: 'p-aval', nome: 'Vanessa', nome_completo: 'VANESSA ROBERT' },
  { profile_id: 'p-rafa', nome: 'Rafael', nome_completo: 'Rafael Souza' },
];
const treinoB = (professor) => [{ id: 1, inicio: '2026-09-01', validade: '2026-12-01', professor }];

test('o briefing: modelo fixo, com o mínimo de dado de saúde', () => {
  const t = textoDoBriefing({
    aluno: 'Claudia', idade: 56, motivo: 'treino de musculação vencendo', urgencia: 'proximos_dias',
    resumo: 'Treino vence em 6 dia(s).', combinado: combinadoDaFicha(fichaB), acompanhamento: acompanhamentoDaFicha(fichaB),
    linkFicha: 'https://prescrev/x',
  });
  assert.equal(t, [
    '📋 *Acompanhamento — encaminhamento*',
    '*Aluno(a):* Claudia, 56 anos',
    '*Motivo:* treino de musculação vencendo — *nos próximos dias*',
    '*Resumo:* Treino vence em 6 dia(s).',
    '*Combinado:* 5× por semana: Musculação, Mat Pilates',
    '*Acompanhamento:* desafiadora (2ª técnica) · reavaliação 21/11',
    'Ficha: https://prescrev/x',
    'Suas opções, digite:',
    '1 - vou responder mais tarde ou pessoalmente',
    '2 - está resolvido',
    '3 - Não é comigo',
  ].join('\n'));
  assert.match(textoDoBriefing({ teste: true, aluno: 'Aluno de teste', motivo: 'x', urgencia: 'hoje' }),
    /^🧪 \*TESTE — não é de um aluno de verdade\*\n.*\n.*\n\*Motivo:\* x — \*responder hoje\*/);
});

test('o briefing não leva o número do aluno: com a ponte, as opções do responsável (A5d)', () => {
  const t = textoDoBriefing({
    aluno: 'Claudia', motivo: 'dor ou lesão', urgencia: 'hoje', resumo: 'dor no joelho.', ponte: true, linkFicha: 'https://prescrev/x',
  });
  assert.doesNotMatch(t, /wa\.me|\d{10,}/);
  // O bloco final, literal (texto do responsável em 09/10/2026).
  assert.ok(t.endsWith([
    'Ficha: https://prescrev/x',
    'Suas opções:',
    'Converse com o cliente, através do whats da AP, arrastando pro lado esta mensagem e respondendo ou digite:',
    '1 - vou responder mais tarde ou pessoalmente',
    '2 - está resolvido',
    '3 - Não é comigo',
  ].join('\n')), t);
  assert.doesNotMatch(textoDoBriefing({ aluno: 'Claudia', motivo: 'x', urgencia: 'hoje' }), /Converse com o cliente/);
});

test('a linha da opção copiada do briefing é o número, sem nota', () => {
  assert.deepEqual(lerRespostaDoBriefing('1 - vou responder mais tarde ou pessoalmente'), { numero: '1', nota: null });
  assert.deepEqual(lerRespostaDoBriefing('2 - Está resolvido'), { numero: '2', nota: null });
  assert.deepEqual(lerRespostaDoBriefing('3 - nao e comigo'), { numero: '3', nota: null });
  assert.deepEqual(lerRespostaDoBriefing('1 - falo com ela na quinta'), { numero: '1', nota: 'falo com ela na quinta' });
});

test('a resposta ao briefing: o número sozinho, e o resto vira nota', () => {
  assert.deepEqual(['1', ' 2 ', '3 - férias', '1. vou ligar amanhã', '2:ok'].map(lerRespostaDoBriefing), [
    { numero: '1', nota: null }, { numero: '2', nota: null }, { numero: '3', nota: 'férias' },
    { numero: '1', nota: 'vou ligar amanhã' }, { numero: '2', nota: 'ok' },
  ]);
  assert.deepEqual(['10 minutos', '4', 'ok', '1234', ''].map(lerRespostaDoBriefing), [null, null, null, null, null]);
});

test('o que volta ao professor', () => {
  assert.equal(textoDaResposta({ numero: '1', aluno: 'Claudia' }), 'Anotado: você assumiu o encaminhamento de Claudia.');
  assert.equal(textoDaResposta({ numero: '3', aluno: 'Claudia', repassadoA: 'Ana' }), 'Anotado: o encaminhamento de Claudia foi para Ana.');
  assert.match(textoDaResposta({ numero: '3', aluno: 'Claudia', nivel: 'coordenacao' }), /fica na tela Acompanhamento/);
});

test('destino: o card, depois quem prescreveu o treino no EVO, depois o avaliador', () => {
  const card = { ...fichaB, professor: { profile_id: 'p-rafa', nome: 'Rafael Souza', origem: 'card' } };
  assert.deepEqual(destinoDoAluno({ ficha: card, treinos: treinoB('VANESSA ROBERT'), hoje: '2026-10-12', equipe: equipeB }),
    { profile_id: 'p-rafa', nome: 'Rafael', origem: 'card' });
  // o treino é do Rafael (grafia diferente, sem acento) e o card não escolheu
  assert.deepEqual(destinoDoAluno({ ficha: fichaB, treinos: treinoB('RAFAEL  SOUZA'), hoje: '2026-10-12', equipe: equipeB }),
    { profile_id: 'p-rafa', nome: 'Rafael', origem: 'treino_evo' });
  // professor do treino fora do Prescrev: vale o avaliador
  assert.deepEqual(destinoDoAluno({ ficha: fichaB, treinos: treinoB('Fulano de Tal'), hoje: '2026-10-12', equipe: equipeB }),
    { profile_id: 'p-aval', nome: 'Vanessa', origem: 'avaliador' });
  assert.equal(destinoDoAluno({ ficha: { ...fichaB, professor: null }, treinos: [], hoje: '2026-10-12', equipe: equipeB }), null);
});

// 08/10/2026 é quinta-feira.
const sp = (s) => new Date(`${s}-03:00`);
const MANHA = { 1: [['06:00', '12:00']], 2: [['06:00', '12:00']], 3: [['06:00', '12:00']], 4: [['06:00', '12:00']], 5: [['06:00', '12:00']] };
const TARDE = { 1: [['13:00', '21:00']], 2: [['13:00', '21:00']], 3: [['13:00', '21:00']], 4: [['13:00', '21:00']], 5: [['13:00', '21:00']] };

test('coordenador de plantão: no horário antes de quem entra depois; empate, quem ativou primeiro; nunca quem já recebeu', () => {
  const ativos = [
    { phone: 'a', profile_id: 'a', papel: 'professor', ativado_em: '2026-10-01' },
    { phone: 'b', profile_id: 'b', papel: 'coordinator', ativado_em: '2026-10-05' },
    { phone: 'c', profile_id: 'c', papel: 'coordinator', ativado_em: '2026-10-02' },
    { phone: 'd', profile_id: 'd', papel: 'coordinator', ativado_em: '2026-10-01' }, // sem horário
  ];
  const horarios = new Map([['a', MANHA], ['b', MANHA], ['c', MANHA]]);
  const p = (agora, extra = {}) => ({ horarios, agora: sp(agora), urgencia: 'proximos_dias', ...extra });
  assert.equal(coordenadorDePlantao(ativos, null, p('2026-10-08T09:00')).phone, 'c');
  assert.equal(coordenadorDePlantao(ativos, 'c', p('2026-10-08T09:00')).phone, 'b');
  // c só à tarde: b, no horário agora, vem antes
  const tardeC = new Map([...horarios, ['c', TARDE]]);
  assert.equal(coordenadorDePlantao(ativos, null, { ...p('2026-10-08T09:00'), horarios: tardeC }).phone, 'b');
  assert.equal(coordenadorDePlantao(ativos, null, p('2026-10-08T09:00')).envio.acao, 'enviar');
  // "hoje" às 13h: ninguém da manhã serve mais
  assert.equal(coordenadorDePlantao(ativos, null, p('2026-10-08T13:00', { urgencia: 'hoje' })), null);
  assert.equal(coordenadorDePlantao([{ phone: 'a', profile_id: 'a', papel: 'professor' }], null, p('2026-10-08T09:00')), null);
});

test('rotear: o professor no horário; fora do resto de hoje, a coordenação; sem ninguém, a tela', () => {
  const ativos = [
    { phone: 'p', profile_id: 'prof', nome: 'Rafael', papel: 'professor', ativado_em: '2026-10-01' },
    { phone: 'c', profile_id: 'coord', nome: 'Ana', papel: 'coordinator', ativado_em: '2026-10-01' },
  ];
  const horarios = new Map([['prof', MANHA], ['coord', TARDE]]);
  const r = (agora, urgencia, extra = {}) => {
    const x = rotear({ urgencia, origem: 'regua', professorId: 'prof', ativos, horarios, agora: sp(agora), ...extra });
    return { para: x.pessoa?.nome ?? null, nivel: x.nivel, acao: x.quando?.acao ?? null, notas: x.notas };
  };
  assert.deepEqual(r('2026-10-08T09:00', 'hoje'), { para: 'Rafael', nivel: 'professor', acao: 'enviar', notas: [] });
  // 14h: a manhã do Rafael acabou; a tarde da Ana está correndo
  assert.deepEqual(r('2026-10-08T14:00', 'hoje'),
    { para: 'Ana', nivel: 'coordenacao', acao: 'enviar', notas: ['Rafael: fora do horário de trabalho no resto de hoje'] });
  // próximos dias: espera a manhã do Rafael
  assert.deepEqual(r('2026-10-08T14:00', 'proximos_dias'), { para: 'Rafael', nivel: 'professor', acao: 'fila', notas: [] });
  // 22h e "hoje": ninguém trabalha mais hoje
  // urgente às 22h: ninguém da coordenação trabalha mais hoje — vai ao professor, no próximo turno
  assert.deepEqual(r('2026-10-08T22:00', 'hoje'), {
    para: 'Rafael', nivel: 'professor', acao: 'fila',
    notas: ['Rafael: fora do horário de trabalho no resto de hoje', 'ninguém da coordenação trabalha mais hoje: vai ao professor no próximo turno'],
  });
  // professor sem EQUIPE: coordenação
  assert.deepEqual(r('2026-10-08T14:00', 'proximos_dias', { professorId: 'outro' }).notas, ['o professor ainda não ativou o EQUIPE']);
  // o teste não vai à coordenação: espera o turno de quem vai testar
  const t = rotear({ urgencia: 'hoje', origem: 'teste', professorId: 'prof', ativos, horarios, agora: sp('2026-10-08T22:00') });
  assert.deepEqual([t.pessoa.nome, t.quando.acao, t.quando.enviarEm.toISOString()], ['Rafael', 'fila', sp('2026-10-09T06:00').toISOString()]);
});

// ---- ativação do aluno ----

test('ATIVAR: só seis caracteres têm cara de código — "ativar meu plano" é de cliente', () => {
  assert.deepEqual(['ATIVAR K7P2QX', 'ativar k7p2qx', ' Ativar  K7P 2QX '].map(lerComandoAtivar), ['K7P2QX', 'K7P2QX', 'K7P2QX']);
  assert.deepEqual(['ATIVAR K7P2Q0', 'ativar cartao'].map(lerComandoAtivar), ['', '']);
  assert.deepEqual(['ativar meu plano', 'ativar', 'quero ativar K7P2QX', 'ATIVAR K7P2QX agora', 'Ativar o app?'].map(lerComandoAtivar),
    [null, null, null, null, null]);
});

test('o mesmo número, com ou sem DDI e nono dígito', () => {
  assert.equal(mesmoNumero('5511987654321', '(11) 98765-4321'), true);
  assert.equal(mesmoNumero('551187654321', '11987654321'), true); // sem o nono dígito
  assert.equal(mesmoNumero('5511987654321', '11987650000'), false);
  assert.equal(mesmoNumero('5511987654321', null), false);
});

test('o aceite: cadência por extenso, professor só pelo nome, e como parar', () => {
  const t = textoDoAceite({ nome: 'Marta', professor: 'Rafael', cadenciaDias: 7 });
  assert.match(t, /^Pronto, Marta! Seu acompanhamento está ativo/);
  assert.match(t, /mais ou menos uma vez por semana/);
  assert.match(t, /Rafael, que acompanha você na academia, fica sabendo/);
  assert.match(t, /\*PAUSAR ACOMPANHAMENTO\*.*\*SAIR\*/);
  assert.doesNotMatch(t, /\bo Rafael\b|\ba Rafael\b/);
  assert.match(textoDoAceite({ nome: null, professor: null, cadenciaDias: null }), /de tempos em tempos[\s\S]*a equipe que acompanha você/);
  assert.deepEqual([3, 7, 14, 11].map(cadenciaPorExtenso), ['a cada 3 dias', 'uma vez por semana', 'a cada duas semanas', 'a cada 11 dias']);
});
