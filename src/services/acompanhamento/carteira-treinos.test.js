import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehSegmentacaoDaCarteira, linhaDaSegmentacao } from './carteira-treinos.js';

const pessoa = { idMember: 19588, fullName: 'Fulano de Tal', status: 'active' };

test('a segmentação sem descrição é da carteira; a de campanha, não', () => {
  assert.equal(ehSegmentacaoDaCarteira({ eventType: 'crm.segmentation.batch', person: pessoa }), true);
  assert.equal(ehSegmentacaoDaCarteira({ eventType: 'crm.segmentation.batch', person: pessoa,
    communication: { message: 'Campanha de renovação' } }), false);
  assert.equal(ehSegmentacaoDaCarteira({ eventType: 'crm.automation.no_attendance', person: pessoa }), false);
  assert.equal(ehSegmentacaoDaCarteira({ eventType: 'crm.segmentation.batch', person: { idProspect: 5 } }), false);
});

test('a linha da carteira leva o nome, o plano e o status', () => {
  const l = linhaDaSegmentacao({ person: pessoa, membership: [{ nameMembership: ' Plano X ' }] }, new Date('2026-11-11T20:37:00Z'));
  assert.deepEqual(l, { id_member: 19588, nome: 'Fulano de Tal', plano: 'Plano X', status_evo: 'active',
    segmentado_em: '2026-11-11T20:37:00.000Z' });
});
