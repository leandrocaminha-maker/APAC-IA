import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avisosDosEncontros, convitesQueSaem, encontroPorExtenso, ferramentaDoEncontro, lembretesDosEncontros, sessaoDaGrade,
  textoDaSessao, textoDoLembreteDoEncontro,
} from './encontros.js';
import { encontroNoContexto } from './conversa.js';

const marcacao = (extra = {}) => ({
  id: 'm1', inicio: '2026-11-17T10:15:00.000Z', dia: '2026-11-17', hora: '07:15', modalidade: 'musculacao',
  professor_id: 'rog', professor_nome: 'ROGÉRIO PASSANHA', cliente_id: 'c1', cliente_nome: 'maria souza',
  caminho: '/dashboard/clientes/c1', cancelado_em: null, ...extra,
});

test('o encontro por extenso: dia da semana, hora curta, atividade e o professor sem artigo', () => {
  assert.equal(encontroPorExtenso(marcacao()), 'terça, 17/11, às 7h15, na musculação, com Rogério');
  assert.equal(encontroPorExtenso(marcacao({ modalidade: 'natacao', hora: '18:20' })), 'terça, 17/11, às 18h20, na natação, com Rogério');
});

test('a sessão da grade: a mesma atividade do EVO e o mesmo início', () => {
  const grade = [
    { idActivity: 18, startTime: '07:15', idConfiguration: 259 },
    { idActivity: 53, startTime: '07:15', idConfiguration: 300 },
    { idActivity: 18, startTime: '07:45', idConfiguration: 1890 },
  ];
  assert.equal(sessaoDaGrade(grade, { hora: '07:15', idsEvo: [18, 41] }).idConfiguration, 259);
  assert.equal(sessaoDaGrade(grade, { hora: '08:15', idsEvo: [18] }), null);
});

test('o convite: um por aluno e semana, só a inscrição ativa, e a marca esquece depois de 30 dias', () => {
  const agora = new Date('2026-11-13T13:00:00Z');
  const convites = [
    { cliente_id: 'c1', semana: 3, texto: 'x' },
    { cliente_id: 'c2', semana: 6, texto: 'y' },
    { cliente_id: 'c3', semana: 4, texto: 'z' },
  ];
  const marca = { enviados: { 'c1|3': { em: '2026-11-12T13:00:00Z', estado: 'enviado' }, 'c9|3': { em: '2026-09-01T00:00:00Z', estado: 'enviado' } } };
  const ativas = new Map([['c1', { phone: '1' }], ['c2', { phone: '2' }]]);
  const r = convitesQueSaem({ convites, marca, ativas, agora });
  assert.deepEqual(r.sair.map(s => s.convite.cliente_id), ['c2']);
  assert.deepEqual(Object.keys(r.marca.enviados), ['c1|3']);
});

test('a agenda do professor: no começo do turno, a lista do dia com o link; na natação, a hora do encontro', () => {
  const agora = new Date('2026-11-17T09:00:00Z');
  const pessoas = [{ profile_id: 'rog', phone: '55', nome: 'Rogério Passanha' }];
  const marcacoes = [marcacao(), marcacao({ id: 'm2', inicio: '2026-11-17T21:20:00.000Z', hora: '18:20', modalidade: 'natacao', cliente_nome: 'João' })];
  const r = avisosDosEncontros({ marcacoes, marca: null, pessoas, dia: '2026-11-17', agora, url: 'https://p.x/' });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Rogério, seus encontros de meta de hoje:/);
  assert.match(r.envios[0].texto, /• 7h15 · maria souza \(musculação\)\n {2}https:\/\/p\.x\/dashboard\/clientes\/c1/);
  assert.match(r.envios[0].texto, /• 18h20 · João \(natação, encontro às 18h55\)/);
  // Depois: só o que entrou e o que saiu.
  const r2 = avisosDosEncontros({
    marcacoes: [marcacao({ cancelado_em: '2026-11-17T09:30:00Z' }), marcacoes[1]],
    marca: r.marca, pessoas, dia: '2026-11-17', agora: new Date('2026-11-17T09:40:00Z'), url: 'https://p.x/',
  });
  assert.equal(r2.envios[0].texto, 'Rogério, saiu da sua agenda de hoje: 7h15 · maria souza.');
});

test('o lembrete da véspera: os marcadores preenchidos, e um por marcação', () => {
  const modelo = '{nome}, amanhã às {hora} tem o seu encontro de meta com {professor}, na {atividade}.';
  assert.equal(textoDoLembreteDoEncontro(modelo, marcacao()), 'Maria, amanhã às 7h15 tem o seu encontro de meta com Rogério, na musculação.');
  const ativas = new Map([['c1', { phone: '1' }]]);
  const r = lembretesDosEncontros({ marcacoes: [marcacao()], modelo, marca: { dia: '2026-11-17', enviados: { m1: 'enviado' } }, ativas, amanha: '2026-11-17' });
  assert.equal(r.sair.length, 0);
  const r2 = lembretesDosEncontros({ marcacoes: [marcacao()], modelo, marca: null, ativas, amanha: '2026-11-17' });
  assert.equal(r2.sair.length, 1);
});

test('no contexto da Leia: o marcado, ou a semana a marcar a partir do convite', () => {
  const encontro = { semana: 3, de: '2026-11-16', ate: '2026-11-22', convite: '2026-11-13', marcado: null };
  assert.equal(encontroNoContexto(encontro, '2026-11-12'), null);
  assert.match(encontroNoContexto(encontro, '2026-11-13'), /a marcar: semana de 16\/11 a 22\/11/);
  assert.equal(encontroNoContexto(encontro, '2026-11-23'), null);
  assert.match(encontroNoContexto({ ...encontro, marcado: marcacao() }, '2026-11-14'),
    /marcado: terça, 17\/11, às 7h15, na musculação, com Rogério/);
});

test('marcar pela Leia: o Prescrev marca, a sessão anterior sai do EVO, a nova entra, e a ficha fica sabendo', async () => {
  const chamadas = [];
  const deps = {
    habilitado: () => true,
    marcar: async (a) => { chamadas.push(['marcar', a]); return { marcacao: marcacao(), anteriores: [marcacao({ id: 'm0', evo_reservado_em: 'x', evo_id_configuration: 1 })] }; },
    cancelar: async ({ marcacao: m }) => { chamadas.push(['cancelar', m.id]); return 'cancelada'; },
    reservar: async ({ marcacao: m }) => { chamadas.push(['reservar', m.id]); return 'reservada'; },
    atualizarFicha: async (c, m) => { chamadas.push(['ficha', c, m?.id ?? null]); },
  };
  const turno = { encontros: [] };
  const r = await ferramentaDoEncontro('marcar_encontro', { dia: '2026-11-17', hora: '07:15', modalidade: 'musculacao' }, { ficha: {}, clienteId: 'c1', turno }, deps);
  assert.equal(r.success, true);
  assert.equal(r.marcado, 'terça, 17/11, às 7h15, na musculação, com Rogério');
  assert.equal(r.mensagem, textoDaSessao('reservada'));
  assert.deepEqual(chamadas.map(c => c[0]), ['marcar', 'cancelar', 'reservar', 'ficha']);
  assert.equal(turno.encontros[0].remarcado, true);
});

test('sem o encontro ligado, a Leia não marca; horário tomado vira "ofereça outro"; argumento torto é recusado', async () => {
  const desligado = await ferramentaDoEncontro('marcar_encontro', {}, { clienteId: 'c1' }, { habilitado: () => false });
  assert.equal(desligado.success, false);
  const tomado = await ferramentaDoEncontro('marcar_encontro', { dia: '2026-11-17', hora: '07:15', modalidade: 'musculacao' },
    { ficha: {}, clienteId: 'c1' }, { habilitado: () => true, marcar: async () => { throw new Error('Prescrev /x: HTTP 409 — tomado'); } });
  assert.match(tomado.mensagem, /não está mais livre/);
  const torto = await ferramentaDoEncontro('marcar_encontro', { dia: '17/11', hora: '7h', modalidade: 'pilates' }, { clienteId: 'c1' }, { habilitado: () => true });
  assert.equal(torto.success, false);
});

test('desmarcar pela Leia: a sessão reservada sai do EVO e a ficha fica sem marcação', async () => {
  const chamadas = [];
  const r = await ferramentaDoEncontro('desmarcar_encontro', {}, { ficha: {}, clienteId: 'c1', turno: { encontros: [] } }, {
    habilitado: () => true,
    desmarcar: async () => ({ canceladas: [marcacao({ evo_reservado_em: 'x', evo_id_configuration: 259 })] }),
    cancelar: async ({ marcacao: m }) => { chamadas.push(m.id); return 'cancelada'; },
    atualizarFicha: async (c, m) => { chamadas.push(m); },
  });
  assert.deepEqual(r.desmarcados, ['terça, 17/11, às 7h15, na musculação, com Rogério']);
  assert.deepEqual(chamadas, ['m1', null]);
});
