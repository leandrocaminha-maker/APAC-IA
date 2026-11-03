/**
 * Testes dos avisos da avaliação física: reconhecer a compra e a automação,
 * quando cada aviso sai e o que o texto diz.
 *
 *   node --test src/services/avaliacao-avisos-regras.test.js
 *
 * Puros: só cálculo, sem banco. São Paulo é UTC-3: 17h em SP são 20h UTC.
 * Novembro de 2026: 03 é terça, 07 sábado, 08 domingo, 09 segunda.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agendaDoAviso, etapaDaAutomacao, hora, horarioDaSessao, prazoDeDesmarcar, quando,
  sessaoDaAvaliacao, temAvaliacaoNaVenda, textoDoAviso, primeiroNome, generoDe,
} from './avaliacao-avisos-regras.js';
import { horarioDoLembrete } from './followup.js';

const sp = (iso) => new Date(`${iso}-03:00`);
const LINK = 'https://forms.gle/XMhpT7G6eceFKewW9';

// ── a compra ──

test('a venda do AF E CONSULTORIA é a compra da avaliação, pelo id do serviço', () => {
  assert.equal(temAvaliacaoNaVenda({ saleItens: [{ item: 'AF E CONSULTORIA', idService: 83 }] }), true);
});

test('pelo nome, se o id mudar', () => {
  assert.equal(temAvaliacaoNaVenda({ saleItens: [{ item: 'AF E CONSULTORIA', idService: 99 }] }), true);
});

test('a remarcação (a taxa) não é compra nova', () => {
  assert.equal(temAvaliacaoNaVenda({ saleItens: [{ item: 'REMARCAÇÃO AF E CONSULTORIA', idService: 34 }] }), false);
});

test('plano sozinho não é avaliação', () => {
  assert.equal(temAvaliacaoNaVenda({ saleItens: [{ item: 'PERFORMA MENSAL', idMembership: 1099 }] }), false);
});

// ── a automação ──

test('a automação da avaliação 3 dias antes pede o aviso dos 3 dias', () => {
  assert.equal(etapaDaAutomacao({ eventLabel: 'avaliacao_3_dias', eventContext: { moment: 'before', daysOffset: 3 } }), 'tres_dias');
});

test('a da véspera, com acento no nome', () => {
  assert.equal(etapaDaAutomacao({ eventLabel: 'Avaliação véspera', eventContext: { moment: 'before', daysOffset: 1 } }), 'vespera');
});

test('as outras automações do CRM passam direto', () => {
  assert.equal(etapaDaAutomacao({ eventLabel: 'sem presenca 10', eventContext: { moment: 'after', daysOffset: 10 } }), null);
  assert.equal(etapaDaAutomacao({ eventLabel: 'avaliacao_feita', eventContext: { moment: 'after', daysOffset: 1 } }), null);
  assert.equal(etapaDaAutomacao({ eventLabel: 'avaliacao_hoje', eventContext: { moment: 'same_day', daysOffset: 0 } }), null);
});

// ── a sessão ──

test('a sessão do EVO vira o horário de São Paulo', () => {
  assert.equal(horarioDaSessao({ date: '2026-11-04T00:00:00', startTime: '17:00' }).toISOString(), '2026-11-04T20:00:00.000Z');
});

test('a sessão da avaliação é a da atividade 9, no dia que a automação diz', () => {
  const sessoes = [
    { idActivitie: 18, date: '2026-11-06T00:00:00', startTime: '10:15', idActivitieSession: 1 },
    { idActivitie: 9, date: '2026-11-01T00:00:00', startTime: '17:00', idActivitieSession: 2 },
    { idActivitie: 9, date: '2026-11-09T00:00:00', startTime: '09:15', idActivitieSession: 3 },
    { idActivitie: 9, date: '2026-11-06T00:00:00', startTime: '20:00', idActivitieSession: 4 },
  ];
  const r = sessaoDaAvaliacao(sessoes, { diaAlvo: '2026-11-06', agora: sp('2026-11-03T10:00') });
  assert.equal(r.sessao.idActivitieSession, 4);
  const semDia = sessaoDaAvaliacao(sessoes, { diaAlvo: '2026-11-20', agora: sp('2026-11-03T10:00') });
  assert.equal(semDia.sessao.idActivitieSession, 4, 'sem a do dia, a próxima');
});

test('o professor e o sexo do cadastro', () => {
  assert.equal(primeiroNome('VANESSA ROBERT'), 'Vanessa');
  assert.equal(primeiroNome('GUSTAVO '), 'Gustavo');
  assert.equal(generoDe('Female'), 'F');
  assert.equal(generoDe('male'), 'M');
  assert.equal(generoDe(null), null);
});

// ── quando sai ──

test('véspera de uma avaliação de quarta às 17h: terça às 17h, e não sai depois das 4h de quarta', () => {
  const a = agendaDoAviso('vespera', { agora: sp('2026-11-03T08:00'), sessaoEm: sp('2026-11-04T17:00') });
  assert.equal(a.previsto.toISOString(), sp('2026-11-03T17:00').toISOString());
  assert.equal(a.prazo.toISOString(), sp('2026-11-04T04:00').toISOString());
});

test('avaliação de segunda cedo: o domingo não tem contato, a véspera vai no sábado', () => {
  const a = agendaDoAviso('vespera', { agora: sp('2026-11-05T10:00'), sessaoEm: sp('2026-11-09T08:15') });
  assert.equal(a.previsto.toISOString(), sp('2026-11-07T09:00').toISOString());
});

test('avaliação de segunda à tarde: segunda de manhã já passou do prazo de desmarcar, vai no sábado', () => {
  const a = agendaDoAviso('vespera', { agora: sp('2026-11-05T10:00'), sessaoEm: sp('2026-11-09T17:00') });
  assert.equal(a.previsto.toISOString(), sp('2026-11-07T13:00').toISOString());
});

test('o lembrete da aula experimental continua o de antes: aula de segunda às 17h, aviso na segunda de manhã', () => {
  assert.equal(horarioDoLembrete(sp('2026-11-09T17:00')).toISOString(), sp('2026-11-09T09:00').toISOString());
});

test('a automação da véspera que chega de madrugada: sai na abertura da janela', () => {
  const a = agendaDoAviso('vespera', { agora: sp('2026-11-05T02:05'), sessaoEm: sp('2026-11-05T19:00'), sorteio: () => 0 });
  assert.equal(a.previsto.toISOString(), sp('2026-11-05T09:00').toISOString());
  assert.equal(a.prazo.toISOString(), sp('2026-11-05T06:00').toISOString(), 'e o prazo já passou: não sai');
});

test('o dos 3 dias sai na janela e não depois de 24 h antes', () => {
  const a = agendaDoAviso('tres_dias', { agora: sp('2026-11-03T02:05'), sessaoEm: sp('2026-11-06T20:00'), sorteio: () => 0 });
  assert.equal(a.previsto.toISOString(), sp('2026-11-03T09:00').toISOString());
  assert.equal(a.prazo.toISOString(), sp('2026-11-05T20:00').toISOString());
});

// ── o texto ──

test('o dia e a hora como se fala', () => {
  const agora = sp('2026-11-03T10:00');
  assert.equal(quando(sp('2026-11-03T19:00'), agora), 'hoje');
  assert.equal(quando(sp('2026-11-04T17:00'), agora), 'amanhã');
  assert.equal(quando(sp('2026-11-06T20:00'), agora), 'na sexta, 06/11');
  assert.equal(quando(sp('2026-11-07T09:00'), agora), 'no sábado, 07/11');
  assert.equal(hora(sp('2026-11-04T17:00')), '17h');
  assert.equal(hora(sp('2026-11-04T08:15')), '8h15');
});

test('até quando se desmarca sem taxa', () => {
  assert.equal(prazoDeDesmarcar(sp('2026-11-04T17:00'), sp('2026-11-03T17:00')), 'amanhã às 5h');
  assert.equal(prazoDeDesmarcar(sp('2026-11-04T08:15'), sp('2026-11-03T10:00')), 'hoje às 20h15');
  assert.equal(prazoDeDesmarcar(sp('2026-11-09T08:15'), sp('2026-11-07T09:00')), 'amanhã às 20h15');
  assert.equal(prazoDeDesmarcar(sp('2026-11-09T08:15'), sp('2026-11-06T09:00')), 'domingo às 20h15');
});

test('na compra: o questionário com o link, a ajuda do professor e o preparo — sem "anamnese"', () => {
  const t = textoDoAviso('venda', { nome: 'Marta', genero: 'F', link: LINK });
  assert.match(t, /^Oi, Marta! Aqui é a Leia, da AP\./);
  assert.ok(t.includes(LINK));
  assert.match(t, /precisa chegar antes do dia/);
  assert.match(t, /chama um professor/);
  assert.match(t, /maiô/);
  assert.match(t, /grávida/);
  assert.match(t, /período menstrual/);
  assert.doesNotMatch(t, /anamnese/i);
  assert.equal((t.match(/!/g) ?? []).length, 1, 'uma exclamação');
});

test('o preparo muda pelo sexo do cadastro', () => {
  const m = textoDoAviso('venda', { nome: 'João', genero: 'M', link: LINK });
  assert.match(m, /sunga/);
  assert.doesNotMatch(m, /maiô|menstrual|grávida/);
  const sem = textoDoAviso('venda', { nome: null, genero: null, link: LINK });
  assert.match(sem, /^Oi! /);
  assert.match(sem, /maiô \(mulheres\)/);
});

test('3 dias antes, com o questionário recebido: o horário e o preparo, sem o link', () => {
  const t = textoDoAviso('tres_dias', {
    nome: 'Marta', genero: 'F', link: LINK, sessaoEm: sp('2026-11-06T20:00'), professor: 'Vanessa',
    questionario: true, agora: sp('2026-11-03T10:00'),
  });
  assert.match(t, /Sua avaliação física na AP é na sexta, 06\/11, às 20h, com Vanessa\./);
  assert.match(t, /já chegou/);
  assert.ok(!t.includes(LINK));
});

test('3 dias antes, sem o questionário: vai o link', () => {
  const t = textoDoAviso('tres_dias', {
    nome: 'Marta', genero: 'F', link: LINK, sessaoEm: sp('2026-11-06T20:00'), professor: null,
    questionario: false, agora: sp('2026-11-03T10:00'),
  });
  assert.ok(t.includes(LINK));
  assert.match(t, /às 20h\./, 'sem professor, sem o "com"');
});

test('na véspera: o horário, até quando desmarcar sem a taxa, a tolerância', () => {
  const t = textoDoAviso('vespera', {
    nome: 'Marta', genero: 'F', link: LINK, sessaoEm: sp('2026-11-04T17:00'), professor: 'Gustavo',
    questionario: true, agora: sp('2026-11-03T17:00'),
  });
  assert.match(t, /Sua avaliação física é amanhã, às 17h, com Gustavo\./);
  assert.match(t, /até amanhã às 5h/);
  assert.match(t, /taxa de não comparecimento, de R\$ 30/);
  assert.doesNotMatch(t, /remarcação/, 'o nome da taxa mudou em 03/11/2026');
  assert.match(t, /5 minutos/);
  assert.doesNotMatch(t, /menstrual/, 'na véspera já não dá para trocar o dia por isso');
  assert.ok(!t.includes(LINK));
});
