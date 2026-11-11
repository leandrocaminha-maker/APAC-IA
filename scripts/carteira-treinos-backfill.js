/**
 * scripts/carteira-treinos-backfill.js
 * Traz à carteira de treinos (023) as segmentações já guardadas em
 * `crm_evo_webhook_events` — as que chegaram antes do código que as registra
 * (a primeira, de 337 alunos, em 11/11/2026). Rodar de novo é inofensivo.
 *
 *   node --env-file=.env scripts/carteira-treinos-backfill.js [desde=2026-11-11]
 *
 * Só põe na carteira: o treino o worker lê depois.
 */
import { supabase } from '../src/lib/supabase.js';
import { ehSegmentacaoDaCarteira, linhaDaSegmentacao } from '../src/services/acompanhamento/carteira-treinos.js';

const desde = process.argv[2] || '2026-11-11';
const linhas = new Map();
for (let de = 0; ; de += 1000) {
  const { data, error } = await supabase.from('crm_evo_webhook_events')
    .select('payload, created_at').like('event_type', 'crm.segmentation%').gte('created_at', desde)
    .order('created_at').range(de, de + 999);
  if (error) { console.error(error.message); process.exit(1); }
  for (const e of data ?? []) {
    if (ehSegmentacaoDaCarteira(e.payload)) linhas.set(e.payload.person.idMember, linhaDaSegmentacao(e.payload, new Date(e.created_at)));
  }
  if (!data || data.length < 1000) break;
}
const todas = [...linhas.values()];
for (let i = 0; i < todas.length; i += 200) {
  const { error } = await supabase.from('acomp_carteira_treinos').upsert(todas.slice(i, i + 200), { onConflict: 'id_member' });
  if (error) { console.error(error.message); process.exit(1); }
}
console.log(`${todas.length} aluno(s) na carteira de treinos.`);
