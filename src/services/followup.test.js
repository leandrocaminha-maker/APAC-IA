/**
 * Testes do horário da conversa pós-aula, da janela na hora do envio e da
 * régua de silêncio (uma retomada em 24 h, depois o consultor).
 *
 *   node --test src/services/followup.test.js
 *
 * Puros: só cálculo, sem banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  horarioDoPosAula, estaNaJanela, horarioDoLembrete, lembreteNecessario,
  horarioDaRetomada, diaPassou, decisaoDoSilencio, motivoParaNaoRetomar, textoDoRepasse,
  PREFIXO_REPASSE, TETO_RETOMADAS,
} from './followup.js';

// Horário de São Paulo é UTC-3: 10h em SP são 13h UTC.

test('aula de terça à noite: conversa na quarta às 10h', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-27T22:00:00Z')).toISOString(), '2026-10-28T13:00:00.000Z');
});

test('aula de manhã: conversa na manhã SEGUINTE, depois do aviso do EVO', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-27T11:15:00Z')).toISOString(), '2026-10-28T13:00:00.000Z');
});

test('aula de sábado: domingo não tem contato, vai para a abertura de segunda', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-24T12:00:00Z')).toISOString(), '2026-10-26T12:00:00.000Z');
});

test('aula de sábado antes de feriado (02/11, Finados): pula domingo e feriado, vai para a terça', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-31T12:00:00Z')).toISOString(), '2026-11-03T12:00:00.000Z');
});

test('aula no último dia do mês vira o mês', () => {
  assert.equal(horarioDoPosAula(new Date('2026-09-30T20:00:00Z')).toISOString(), '2026-10-01T13:00:00.000Z');
});

// ── Janela na hora do envio ──────────────────

const sp = (s) => new Date(`${s}-03:00`);

test('a 0h07 de terça não é hora de mandar nada (a Duda recebeu o encerramento assim)', () => {
  assert.equal(estaNaJanela(sp('2026-10-27T00:07:00')), false);
});

test('dia útil das 9h às 20h30; sábado até as 13h; domingo nunca', () => {
  assert.equal(estaNaJanela(sp('2026-10-27T09:00:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-27T20:30:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-27T20:31:00')), false);
  assert.equal(estaNaJanela(sp('2026-10-31T12:59:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-31T13:01:00')), false);
  assert.equal(estaNaJanela(sp('2026-11-01T10:00:00')), false);
});

// ── A régua de silêncio: uma retomada em 24 h, depois o consultor ──
//
// A semana de 23 a 30/11/2026 não tem feriado: segunda 23, sábado 28.

const CFG = { agendarAposHoras: 6, alvoHoras: 21, minimoHoras: 8, limiteHoras: 22.5, envioLimiteHoras: 23.5 };
const meio = () => 0.5;   // folga de 10 min na abertura e de 25 min no fechamento
const iso = (s) => sp(s).toISOString();
const horario = (dela, agora) => horarioDaRetomada(sp(dela), { agora: sp(agora), cfg: CFG, sorteio: meio })?.toISOString() ?? null;
const enviado = (tipo, quando) => ({ tipo, status: 'enviado', sent_at: iso(quando), created_at: iso(quando) });
const decisao = (p) => decisaoDoSilencio({ cfg: CFG, sorteio: meio, ...p, agora: sp(p.agora) });

test('escreveu à tarde: a retomada sai 21 h depois, no dia seguinte', () => {
  assert.equal(horario('2026-11-24T15:00:00', '2026-11-24T22:00:00'), iso('2026-11-25T12:00:00'));
});

test('escreveu às 11h: o alvo cai antes das 9h, e a retomada sai na abertura', () => {
  assert.equal(horario('2026-11-24T11:00:00', '2026-11-24T18:00:00'), iso('2026-11-25T09:10:00'));
});

test('escreveu às 10h: a abertura de amanhã já estoura o prazo, então sai no fim da tarde de hoje', () => {
  assert.equal(horario('2026-11-24T10:00:00', '2026-11-24T16:30:00'), iso('2026-11-24T20:05:00'));
});

test('escreveu de madrugada: sai no fim da tarde do mesmo dia', () => {
  assert.equal(horario('2026-11-23T02:00:00', '2026-11-23T09:00:00'), iso('2026-11-23T20:05:00'));
});

test('sexta à tarde: sai no sábado, antes de a janela fechar às 13h', () => {
  assert.equal(horario('2026-11-27T16:30:00', '2026-11-27T23:00:00'), iso('2026-11-28T12:35:00'));
});

test('sábado ao meio-dia: não há horário em 24 h, e não há retomada', () => {
  assert.equal(horario('2026-11-28T12:30:00', '2026-11-28T19:00:00'), null);
});

test('a varredura chegou atrasada: sai agora, se ainda cabe; depois do limite, não sai', () => {
  assert.equal(horario('2026-11-24T15:00:00', '2026-11-25T13:00:00'), iso('2026-11-25T13:00:00'));
  assert.equal(horario('2026-11-24T15:00:00', '2026-11-25T14:00:00'), null);
});

test('"sem resposta no dia": o repasse espera a abertura do dia seguinte', () => {
  const terca16h = sp('2026-11-24T16:00:00');
  assert.equal(diaPassou(terca16h, sp('2026-11-24T20:00:00')), false);
  assert.equal(diaPassou(terca16h, sp('2026-11-25T08:59:00')), false);
  assert.equal(diaPassou(terca16h, sp('2026-11-25T09:00:00')), true);
  // Sábado: o domingo não conta, e o repasse sai na segunda.
  const sabado = sp('2026-11-28T12:35:00');
  assert.equal(diaPassou(sabado, sp('2026-11-29T10:00:00')), false);
  assert.equal(diaPassou(sabado, sp('2026-11-30T09:00:00')), true);
  // Sexta: o sábado de manhã tem janela.
  assert.equal(diaPassou(sp('2026-11-27T19:00:00'), sp('2026-11-28T09:30:00')), true);
});

test('silêncio de duas horas ainda não é silêncio; de sete, a retomada é agendada', () => {
  const base = { followups: [], respondeuEm: iso('2026-11-24T15:00:00'), nossaUltimaEm: iso('2026-11-24T15:01:00') };
  assert.equal(decisao({ ...base, agora: '2026-11-24T17:00:00' }).acao, 'esperar');

  const d = decisao({ ...base, agora: '2026-11-24T22:00:00' });
  assert.deepEqual([d.acao, d.tipo, d.quando.toISOString()], ['cutucar', 'silencio_1', iso('2026-11-25T12:00:00')]);
  // Quem já fez a aula recebe o roteiro da sondagem.
  assert.equal(decisao({ ...base, fezAula: true, agora: '2026-11-24T22:00:00' }).tipo, 'sondagem_1');
});

test('com mensagem agendada (o lembrete da aula de amanhã), a régua não mexe', () => {
  const d = decisao({
    followups: [{ tipo: 'ae_lembrete_24h', status: 'pendente', created_at: iso('2026-11-24T10:00:00') }],
    respondeuEm: iso('2026-11-23T15:00:00'), nossaUltimaEm: iso('2026-11-23T15:01:00'), agora: '2026-11-25T10:00:00',
  });
  assert.equal(d.acao, 'nada');
});

test('não respondeu à retomada: espera o dia dela, e depois vai para o consultor', () => {
  const base = {
    followups: [enviado('silencio_1', '2026-11-25T12:00:00')],
    respondeuEm: iso('2026-11-24T15:00:00'), nossaUltimaEm: iso('2026-11-25T12:00:00'),
  };
  assert.equal(decisao({ ...base, agora: '2026-11-25T18:00:00' }).acao, 'esperar');

  const d = decisao({ ...base, agora: '2026-11-26T09:30:00' });
  assert.deepEqual([d.acao, d.causa, d.enviadoEm], ['repassar', 'retomada', iso('2026-11-25T12:00:00')]);
});

test('não há segunda tentativa: a de quem não respondeu à primeira pela régua antiga também vai para o consultor', () => {
  const d = decisao({
    followups: [enviado('silencio_1', '2026-11-13T09:20:00')],
    respondeuEm: iso('2026-11-11T10:00:00'), nossaUltimaEm: iso('2026-11-13T09:20:00'), agora: '2026-11-23T10:00:00',
  });
  assert.deepEqual([d.acao, d.causa], ['repassar', 'retomada']);
});

test('quem recebeu as duas rodadas da régua antiga fica para o encerramento antigo', () => {
  const d = decisao({
    followups: [enviado('silencio_1', '2026-11-12T09:20:00'), enviado('silencio_2', '2026-11-14T09:40:00')],
    respondeuEm: iso('2026-11-10T10:00:00'), nossaUltimaEm: iso('2026-11-14T09:40:00'), agora: '2026-11-23T10:00:00',
  });
  assert.equal(d.acao, 'nada');
});

test('Amanda: respondeu à retomada e sumiu de novo — é outro silêncio, com retomada própria', () => {
  const d = decisao({
    followups: [enviado('silencio_1', '2026-11-23T12:13:00')],
    respondeuEm: iso('2026-11-23T13:22:00'), nossaUltimaEm: iso('2026-11-23T13:23:00'), agora: '2026-11-23T20:00:00',
  });
  assert.deepEqual([d.acao, d.tipo, d.quando.toISOString()], ['cutucar', 'silencio_1', iso('2026-11-24T10:22:00')]);
});

test('não respondeu à conversa de depois da aula: consultor no dia seguinte, sem sondagem', () => {
  const base = {
    followups: [enviado('ae_lembrete_24h', '2026-11-23T19:00:00'), enviado('ae_pos_aula', '2026-11-25T10:00:00')],
    respondeuEm: iso('2026-11-23T19:05:00'), nossaUltimaEm: iso('2026-11-25T10:00:00'), fezAula: true,
  };
  assert.equal(decisao({ ...base, agora: '2026-11-25T15:00:00' }).acao, 'esperar');

  const d = decisao({ ...base, agora: '2026-11-26T09:05:00' });
  assert.deepEqual([d.acao, d.causa], ['repassar', 'pos_aula']);
});

test('sábado ao meio-dia: sem retomada possível, o consultor recebe na segunda', () => {
  const base = { followups: [], respondeuEm: iso('2026-11-28T12:30:00'), nossaUltimaEm: iso('2026-11-28T12:31:00') };
  assert.equal(decisao({ ...base, agora: '2026-11-28T19:00:00' }).acao, 'esperar');
  assert.equal(decisao({ ...base, agora: '2026-11-29T10:00:00' }).acao, 'esperar');

  const d = decisao({ ...base, agora: '2026-11-30T09:10:00' });
  assert.deepEqual([d.acao, d.causa], ['repassar', 'sem_retomada']);
});

test('calado há dias sem nunca ter sido retomado (o número estava fora): consultor', () => {
  const d = decisao({
    followups: [], respondeuEm: iso('2026-11-20T17:00:00'), nossaUltimaEm: iso('2026-11-20T17:01:00'), agora: '2026-11-24T10:00:00',
  });
  assert.deepEqual([d.acao, d.causa], ['repassar', 'sem_retomada']);
});

test('o consultor já teve este silêncio: a régua não repassa de novo', () => {
  const base = {
    followups: [enviado('silencio_1', '2026-11-24T12:00:00')],
    respondeuEm: iso('2026-11-23T15:00:00'), nossaUltimaEm: iso('2026-11-25T11:00:00'), agora: '2026-11-30T10:00:00',
  };
  assert.equal(decisao({ ...base, repasseEm: iso('2026-11-25T09:10:00') }).acao, 'nada');
  // A marca de um silêncio anterior não vale para este.
  assert.equal(decisao({ ...base, repasseEm: iso('2026-11-20T09:10:00') }).acao, 'repassar');
});

test('a retomada que falhou não é reagendada de hora em hora: espera o dia e vai para o consultor', () => {
  const base = {
    followups: [{ tipo: 'silencio_1', status: 'falhou', created_at: iso('2026-11-24T22:00:00') }],
    respondeuEm: iso('2026-11-24T15:00:00'), nossaUltimaEm: iso('2026-11-24T15:01:00'),
  };
  assert.equal(decisao({ ...base, agora: '2026-11-24T23:00:00' }).acao, 'esperar');
  assert.deepEqual(
    [decisao({ ...base, agora: '2026-11-25T09:30:00' }).acao, decisao({ ...base, agora: '2026-11-25T09:30:00' }).causa],
    ['repassar', 'sem_retomada'],
  );
});

test('teto de quatro retomadas na vida do lead: a quinta não sai', () => {
  const quatro = [
    enviado('silencio_1', '2026-11-03T12:00:00'), enviado('silencio_2', '2026-11-05T12:00:00'),
    enviado('silencio_1', '2026-11-10T12:00:00'), enviado('silencio_1', '2026-11-17T12:00:00'),
  ];
  const base = { followups: quatro, respondeuEm: iso('2026-11-24T15:00:00'), nossaUltimaEm: iso('2026-11-24T15:01:00') };
  assert.equal(TETO_RETOMADAS, 4);
  assert.equal(decisao({ ...base, agora: '2026-11-24T22:00:00' }).acao, 'esperar');
  assert.equal(decisao({ ...base, agora: '2026-11-25T09:30:00' }).acao, 'repassar');
});

test('quem nunca escreveu não tem 24 h de quê: sem retomada, consultor', () => {
  const d = decisao({ followups: [], respondeuEm: null, nossaUltimaEm: iso('2026-11-24T10:00:00'), agora: '2026-11-25T10:00:00' });
  assert.deepEqual([d.acao, d.causa], ['repassar', 'sem_retomada']);
});

test('na hora do envio: fora das 24 h, da régua antiga ou segunda tentativa, não sai', () => {
  const agora = sp('2026-11-25T12:00:00');
  const com = (tipo, contexto) => motivoParaNaoRetomar({ tipo, contexto }, { agora, cfg: CFG });

  assert.equal(com('silencio_1', { respondeu_em: iso('2026-11-24T15:00:00') }), null);           // 21 h
  assert.match(com('silencio_1', { respondeu_em: iso('2026-11-24T12:20:00') }), /24 h/);          // 23 h 40
  assert.match(com('sondagem_1', { aula: iso('2026-11-23T19:00:00') }), /régua antiga/);
  assert.match(com('silencio_2', { respondeu_em: iso('2026-11-24T15:00:00') }), /segunda tentativa/);
  assert.match(com('sondagem_2', {}), /segunda tentativa/);
  // O lembrete e a conversa de depois da aula não são retomada.
  assert.equal(com('ae_lembrete_24h', {}), null);
  assert.equal(com('ae_pos_aula', {}), null);
});

test('o briefing do repasse diz ao consultor o que aconteceu e quando', () => {
  const t = textoDoRepasse({ causa: 'retomada', enviadoEm: iso('2026-11-25T12:00:00'), respondeuEm: iso('2026-11-24T15:05:00') });
  assert.ok(t.startsWith(PREFIXO_REPASSE));
  assert.match(t, /retomada da Leia \(enviada em 25\/11 às 12h00\)/);
  assert.match(t, /Última mensagem do cliente: 24\/11 às 15h05/);
  assert.match(t, /não escreve de novo/);
  assert.match(textoDoRepasse({ causa: 'pos_aula' }), /depois da aula experimental/);
  assert.match(textoDoRepasse({ causa: 'sem_retomada' }), /dentro de 24 h/);
});

// ── Lembrete da aula ─────────────────────────

test('Joyce, 09/11: aula marcada às 7h25 para as 19h15 do mesmo dia não tem lembrete', () => {
  const marcada = sp('2026-11-09T07:25:00');
  const lembrete = horarioDoLembrete(sp('2026-11-09T19:15:00'));
  assert.equal(lembrete.toISOString(), sp('2026-11-09T09:00:00').toISOString());   // o que saiu
  assert.equal(lembreteNecessario(lembrete, marcada), false);
});

test('aula de amanhã com lembrete ainda hoje também não tem lembrete', () => {
  // 06/10: marcada às 14h38 para amanhã às 19h45 — o lembrete saiu às 19h45 de hoje.
  const lembrete = horarioDoLembrete(sp('2026-10-07T19:45:00'));
  assert.equal(lembrete.toISOString(), sp('2026-10-06T19:45:00').toISOString());
  assert.equal(lembreteNecessario(lembrete, sp('2026-10-06T14:38:00')), false);
});

test('lembrete em outro dia que o da marcação continua', () => {
  // Luciana: marcada 30/10 para terça 03/11.
  assert.equal(lembreteNecessario(horarioDoLembrete(sp('2026-11-03T15:45:00')), sp('2026-10-30T09:02:00')), true);
  // Marcada às 20h para amanhã às 21h: o lembrete cai amanhã.
  assert.equal(lembreteNecessario(sp('2026-11-11T20:00:00'), sp('2026-11-10T20:00:00')), true);
});

test('lembrete a menos de 30 min, ou no passado, não sai', () => {
  const agora = sp('2026-11-10T08:50:00');
  assert.equal(lembreteNecessario(sp('2026-11-10T09:10:00'), agora), false);
  assert.equal(lembreteNecessario(sp('2026-11-09T19:15:00'), agora), false);
});
