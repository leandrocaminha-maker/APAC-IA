/**
 * Registra nos leads abertos as aulas experimentais FUTURAS que a
 * consultora marcou direto no EVO e o funil não conhece.
 *
 * Não é rotina: é a limpeza de uma vez do que ficou para trás até a
 * correção de 29/10/2026. Daqui em diante a venda da aula acha o lead pelo
 * celular do cadastro, e a reserva que chega depois da venda é procurada de
 * novo pelo worker do EVO.
 *
 * ## O que ele faz
 *
 * Para cada lead de venda aberto, com movimento nos últimos `--dias` (30)
 * e sem aula futura na ficha, pergunta ao EVO por aula a partir de hoje —
 * no cadastro de aluno, no de oportunidade e, sem este, nos cadastros do
 * celular. Achando, liga o cadastro ao lead se for o caso, move para
 * "experimental agendada" e arma a régua da aula: **o lembrete de 24h e a
 * conversa da manhã seguinte vão sair de verdade**, pelo worker, na janela
 * de contato.
 *
 * Só aula futura de propósito. Registrar as que já passaram dispararia, de
 * uma vez, "como foi a aula?" para aulas de semanas atrás.
 *
 * ## O padrão é SIMULAR
 *
 * Mesmo motivo do `regularizar-parados.js`: ação em lote que manda
 * mensagem a cliente tem que exigir a palavra a mais.
 *
 * Uma pausa entre leads porque o EVO devolve 429 a partir de ~1
 * requisição por segundo, e a Leia usa a mesma conta em produção.
 *
 * Uso:
 *   node scripts/reconciliar-aulas.js              # só mostra o que faria
 *   node scripts/reconciliar-aulas.js --valendo
 *   node scripts/reconciliar-aulas.js --dias=15
 */
import 'dotenv/config';
import { lerTodas, supabase } from '../src/lib/supabase.js';
import { evoSync } from '../src/services/evo-sync.js';
import { FILTRO_ETAPAS_FECHADAS } from '../src/services/funil.js';
import { esperar } from '../src/lib/ritmo.js';

const args = process.argv.slice(2);
const valendo = args.includes('--valendo');
const dias = Number((args.find(a => a.startsWith('--dias=')) || '').split('=')[1]) || 30;
const PAUSA_MS = 2_000;

const piso = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
const agora = new Date();

const { data: leads, error } = await lerTodas(() => supabase
  .from('crm_leads')
  .select('*')
  .eq('trilha', 'lead')
  .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
  .not('phone', 'is', null)
  .gte('last_activity_at', piso));

if (error) {
  console.error('Falha ao ler os leads:', error.message);
  process.exit(1);
}

// Quem já tem aula futura na ficha não precisa de pergunta nenhuma.
const candidatos = leads.filter(l => !(Date.parse(l.experimental_at || '') > agora.getTime()));

console.log(`${valendo ? 'VALENDO' : 'SIMULAÇÃO'} — ${candidatos.length} lead(s) de venda abertos ` +
  `sem aula futura na ficha, com movimento nos últimos ${dias} dias\n`);

const achados = [];
let indefinidos = 0;

for (const [i, lead] of candidatos.entries()) {
  if (i) await esperar(PAUSA_MS / 1000);

  const r = await evoSync.conferirAulaNoEvo(lead, {
    desde: agora, somenteFutura: true, registrar: valendo, actor: 'sistema',
  }).catch(err => ({ indefinido: true, erro: err.message }));

  if (r?.indefinido) {
    indefinidos++;
    console.log(`  ? lead ${lead.id} (${lead.full_name || 'sem nome'}): EVO não respondeu${r.erro ? ` — ${r.erro}` : ''}`);
    continue;
  }
  if (!r?.nova) continue;

  achados.push({ lead, dataHora: r.dataHora });
  console.log(`  ✓ lead ${lead.id} (${lead.full_name || 'sem nome'}, ${lead.stage}): aula em ${r.dataHora}` +
    (valendo ? ' — registrada' : ''));
}

console.log(`\n${achados.length} aula(s) ${valendo ? 'registrada(s)' : 'a registrar'}` +
  (indefinidos ? `, ${indefinidos} lead(s) sem resposta do EVO` : ''));
if (!valendo && achados.length) {
  console.log('Para gravar (e armar lembrete e conversa pós-aula): node scripts/reconciliar-aulas.js --valendo');
}
