/**
 * Testes das regras do painel gerencial.
 *
 *   node --test src/services/gerencia-regras.test.js
 *
 * Puros. Os casos vêm da verificação de 29/10/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarConfig, telefoneDaEquipe, dentroDoHorario, idadeNaData, ehCortesia,
  alertasDe, regraCasa, eventosValendo, avisosDeAula, mensagemDoCiclo, CONFIG_PADRAO,
  aplicarBaixas, chaveDeAlertaValida, TIPOS_ALERTA,
} from './gerencia-regras.js';

const sp = (s) => new Date(`${s}-03:00`);
const AGORA = sp('2026-10-29T16:00:00');

// ── Configuração ─────────────────────────────

test('telefone da equipe aceita formato livre e põe o DDI', () => {
  assert.equal(telefoneDaEquipe('(11) 98259-2538'), '5511982592538');
  assert.equal(telefoneDaEquipe('5511982592538'), '5511982592538');
  assert.equal(telefoneDaEquipe('124094842454020'), null);
});

test('config vazia vira o padrão, com avisos desligados', () => {
  const c = normalizarConfig({});
  assert.equal(c.avisos.ligado, false);
  assert.equal(c.alertas.cliente_sem_resposta.horas, 4);
  assert.equal(c.aulas.regras.length, 1);
  assert.equal(c.aulas.regras[0].ativa, false);
});

test('config fora do lugar é corrigida, não recusada', () => {
  const c = normalizarConfig({
    avisos: { ligado: true, gerente: '11 98259-2538, lixo', horaInicio: '25:00' },
    alertas: { cliente_sem_resposta: { ativo: false, horas: 999 } },
    aulas: { regras: [{ nome: 'Bebê', ativa: true, eventos: ['agendada', 'inventado'], idadeMin: 5, idadeMax: 2 }] },
  });
  assert.deepEqual(c.avisos.gerente, ['5511982592538']);
  assert.equal(c.avisos.horaInicio, '08:00');
  assert.deepEqual(c.alertas.cliente_sem_resposta, { ativo: false, horas: 168 });
  assert.deepEqual(c.aulas.regras[0].eventos, ['agendada']);
  assert.equal(c.aulas.regras[0].idadeMax, 5);
});

test('horário de aviso em hora de São Paulo', () => {
  const h = { horaInicio: '08:00', horaFim: '20:30' };
  assert.equal(dentroDoHorario(sp('2026-10-29T07:59:00'), h), false);
  assert.equal(dentroDoHorario(sp('2026-10-29T08:00:00'), h), true);
  assert.equal(dentroDoHorario(sp('2026-10-29T20:31:00'), h), false);
});

test('idade em anos completos na data da aula', () => {
  assert.equal(idadeNaData('2023-09-25', sp('2026-10-31T10:00:00')), 3);   // Luara
  assert.equal(idadeNaData('2025-09-24', sp('2026-10-31T10:30:00')), 1);   // Emily
  assert.equal(idadeNaData('2020-11-09', sp('2026-11-08T10:00:00')), 5);   // véspera do aniversário
  assert.equal(idadeNaData(null), null);
});

test('cortesia não pede resposta; pergunta pede', () => {
  for (const t of ['Ok, obrigada', 'Combinado', '👍🏽', '[mensagem não suportada]', 'obrigado pela informação.', 'Tá bom']) {
    assert.equal(ehCortesia(t), true, t);
  }
  for (const t of ['Tava vendo a unidade de pinheiros', 'posso saber os horários?', 'Amanhã falamos', '[imagem]']) {
    assert.equal(ehCortesia(t), false, t);
  }
});

// ── Alertas ──────────────────────────────────

const lead = (extra = {}) => ({
  id: 1, full_name: 'Simão', phone: '5511991334465', stage: 'com_consultor',
  stage_since: '2026-10-28T22:00:00Z', consultor: 'Lucas', metadata: {},
  conversa_status: 'active', ultimaNossaAntes: 'consultor', ...extra,
});

test('cliente sem resposta: só depois do limite, e diz quem deve responder', () => {
  const l = lead({ ultima: { quem: 'cliente', texto: 'Tava vendo a unidade de pinheiros', em: '2026-10-28T22:55:00Z', id: 9 } });
  const [a] = alertasDe([l], CONFIG_PADRAO, AGORA);
  assert.equal(a.tipo, 'cliente_sem_resposta');
  assert.equal(a.quemResponde, 'consultor');
  assert.equal(a.chave, 'csr:1:9');
  assert.equal(alertasDe([l], CONFIG_PADRAO, sp('2026-10-28T20:00:00')).length, 0);   // 1h depois: ainda não
});

test('cortesia e número que não é número não viram alerta', () => {
  const ok = lead({ ultima: { quem: 'cliente', texto: 'Ok, obrigada', em: '2026-10-20T12:00:00Z', id: 1 } });
  const fantasma = lead({ phone: '124094842454020', ultima: { quem: 'cliente', texto: 'Nunca treinei', em: '2026-10-20T12:00:00Z', id: 2 } });
  assert.equal(alertasDe([ok, fantasma], CONFIG_PADRAO, AGORA).length, 0);
});

test('aula vendida sem horário e aula feita sem desfecho', () => {
  const vendida = lead({ id: 2, metadata: { aula_vendida: { vendida_em: '2026-10-27T19:14:53Z' } } });
  const feita = lead({ id: 3, stage: 'experimental_agendada', experimental_at: '2026-10-24T13:30:00Z', experimental_activity: 'Natação Bebê 1 e 2' });
  const alertas = alertasDe([vendida, feita], CONFIG_PADRAO, AGORA);
  assert.deepEqual(alertas.map(a => a.tipo), ['aula_sem_reserva', 'aula_sem_desfecho']);
  assert.match(alertas[1].detalhe, /presença não confirmada$/);
});

test('Gabrielly, 03/11: aula que passou sem presença não é "aula feita"', () => {
  const faltou = lead({ id: 4, stage: 'experimental_agendada', experimental_status: 'agendada', experimental_at: '2026-10-24T14:00:00Z' });
  const veio = lead({ id: 5, stage: 'experimental_realizada', experimental_status: 'realizada', experimental_at: '2026-10-24T14:00:00Z' });
  const [a, b] = alertasDe([faltou, veio], CONFIG_PADRAO, AGORA);
  assert.match(a.detalhe, /presença não confirmada/);
  assert.match(b.detalhe, /— presença registrada$/);
  assert.equal(TIPOS_ALERTA.aula_sem_desfecho.rotulo, 'Aula passou sem desfecho');
});

test('falta vista antes das 22h aparece como falta registrada', () => {
  const faltou = lead({ id: 7, stage: 'experimental_agendada', experimental_status: 'faltou', experimental_at: '2026-10-24T14:00:00Z' });
  const [a] = alertasDe([faltou], CONFIG_PADRAO, AGORA);
  assert.match(a.detalhe, /— falta registrada$/);
});

test('aula cancelada no EVO não vira alerta nem aviso de aula', () => {
  const cancelada = lead({ id: 6, stage: 'experimental_agendada', experimental_status: 'cancelada', experimental_at: '2026-10-24T14:00:00Z' });
  assert.deepEqual(alertasDe([cancelada], CONFIG_PADRAO, AGORA).filter(a => a.tipo === 'aula_sem_desfecho'), []);
  const futura = { experimental_at: '2026-10-30T22:00:00Z', experimental_status: 'cancelada', stage: 'experimental_agendada' };
  assert.deepEqual(eventosValendo(futura, sp('2026-10-29T16:00:00')), []);
  assert.deepEqual(eventosValendo({ ...futura, experimental_status: 'agendada' }, sp('2026-10-29T16:00:00')), ['agendada', 'vespera']);
});

test('baixa é do fato: mensagem nova do cliente traz o alerta de volta', () => {
  const antes = lead({ ultima: { quem: 'cliente', texto: 'Tava vendo a unidade de pinheiros', em: '2026-10-28T22:55:00Z', id: 9 } });
  const baixas = { 'csr:1:9': { em: '2026-10-29T18:00:00Z', por: 'Leandro' } };
  const [comBaixa] = aplicarBaixas(alertasDe([antes], CONFIG_PADRAO, AGORA), baixas);
  assert.equal(comBaixa.baixa.por, 'Leandro');

  const depois = lead({ ultima: { quem: 'cliente', texto: 'E aí, alguém?', em: '2026-10-29T12:00:00Z', id: 12 } });
  const [novo] = aplicarBaixas(alertasDe([depois], CONFIG_PADRAO, AGORA), baixas);
  assert.equal(novo.baixa, undefined);
});

test('chave de baixa: só a de alerta', () => {
  assert.equal(chaveDeAlertaValida('csr:1236:98765'), true);
  assert.equal(chaveDeAlertaValida('asd:849:2026-10-24T13:00:00+00:00'), true);
  assert.equal(chaveDeAlertaValida('gerencia:config'), false);
  assert.equal(chaveDeAlertaValida({}), false);
});

test('alerta desligado não aparece', () => {
  const l = lead({ stage: 'aguardando_consultor', stage_since: '2026-10-28T10:00:00Z' });
  const cfg = normalizarConfig({ alertas: { handoff_parado: { ativo: false } } });
  assert.equal(alertasDe([l], CONFIG_PADRAO, AGORA).length, 1);
  assert.equal(alertasDe([l], cfg, AGORA).length, 0);
});

// ── Regras de aula ───────────────────────────

const regra = (extra = {}) => ({
  id: 'r', nome: 'Bebê', ativa: true, eventos: ['agendada'], idadeMin: null, idadeMax: null,
  semIdade: true, atividades: [], diasSemana: [], destino: 'coordenacao', diasSemDesfecho: 3, ...extra,
});
const aula = (extra = {}) => ({
  leadId: 1154, nome: 'Emily', idade: 1, atividade: 'Natação Bebê 1 e 2',
  experimental_at: '2026-10-31T13:30:00Z', stage: 'experimental_agendada', experimental_status: 'agendada', ...extra,
});

test('regra por idade: dentro da faixa casa; fora não; sem idade segue a regra', () => {
  assert.equal(regraCasa(regra({ idadeMin: 0, idadeMax: 3 }), aula()), true);
  assert.equal(regraCasa(regra({ idadeMin: 4, idadeMax: 12 }), aula()), false);
  assert.equal(regraCasa(regra({ idadeMin: 0, idadeMax: 3, semIdade: false }), aula({ idade: null })), false);
  assert.equal(regraCasa(regra({ idadeMin: 0, idadeMax: 3, semIdade: true }), aula({ idade: null })), true);
});

test('regra por atividade casa sem acento e sem caixa; nenhuma escolhida = todas', () => {
  assert.equal(regraCasa(regra({ atividades: ['natacao bebe'] }), aula()), true);
  assert.equal(regraCasa(regra({ atividades: ['Hidroginástica'] }), aula()), false);
  assert.equal(regraCasa(regra({ atividades: [] }), aula({ atividade: 'HIDROGINÁSTICA' })), true);
});

test('regra por dia da semana e regra inativa', () => {
  assert.equal(regraCasa(regra({ diasSemana: [6] }), aula()), true);    // 31/10 é sábado
  assert.equal(regraCasa(regra({ diasSemana: [1, 3] }), aula()), false);
  assert.equal(regraCasa(regra({ ativa: false }), aula()), false);
});

test('eventos: marcada, véspera e dia antes da aula', () => {
  assert.deepEqual(eventosValendo(aula(), sp('2026-10-29T10:00:00')), ['agendada']);
  assert.deepEqual(eventosValendo(aula(), sp('2026-10-30T10:00:00')), ['agendada', 'vespera']);
  assert.deepEqual(eventosValendo(aula(), sp('2026-10-31T08:00:00')), ['agendada', 'dia']);
});

test('eventos depois da aula: sem presença no dia seguinte, sem desfecho depois de N dias', () => {
  const a = aula({ experimental_at: '2026-10-24T13:30:00Z' });   // sáb 24/10, 10h30
  assert.deepEqual(eventosValendo(a, sp('2026-10-25T08:00:00')), []);
  assert.deepEqual(eventosValendo(a, sp('2026-10-25T09:00:00')), ['sem_presenca']);
  assert.deepEqual(eventosValendo(a, sp('2026-10-27T11:00:00')), ['sem_presenca', 'sem_desfecho']);
  assert.deepEqual(eventosValendo({ ...a, experimental_status: 'realizada' }, sp('2026-10-25T10:00:00')), []);
  assert.deepEqual(eventosValendo({ ...a, stage: 'ganho' }, sp('2026-10-27T11:00:00')), []);
});

test('aviso de aula: só os eventos da regra, com chave por aula, evento e regra', () => {
  const cfg = normalizarConfig({ aulas: { regras: [regra({ eventos: ['vespera'] })] } });
  assert.equal(avisosDeAula([aula()], cfg, sp('2026-10-29T10:00:00')).length, 0);
  const [a] = avisosDeAula([aula()], cfg, sp('2026-10-30T10:00:00'));
  assert.equal(a.chave, 'aula:1154:2026-10-31T13:30:00Z:vespera:r');
  assert.equal(a.destino, 'coordenacao');
});

test('mensagem do ciclo agrupa por tipo e corta no limite', () => {
  const alertas = Array.from({ length: 10 }, (_, i) => ({
    tipo: 'cliente_sem_resposta', nome: `Lead ${i}`, telefone: '5511991334465', desde: '2026-10-28T22:55:00Z',
    detalhe: 'oi', quemResponde: 'consultor',
  }));
  const texto = mensagemDoCiclo({ alertas, link: 'https://crm.apacademia.com.br/crm' }, AGORA);
  assert.match(texto, /10 situações novas/);
  assert.match(texto, /Cliente sem resposta\* \(10\)/);
  assert.match(texto, /…e mais 2 no painel/);
  assert.equal(mensagemDoCiclo({}, AGORA), null);
});
