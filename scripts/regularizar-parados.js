/**
 * Regularização do acumulado que travou o fim da régua de follow-up.
 *
 * Não é rotina: é a limpeza de uma vez do que três defeitos deixaram para
 * trás. Depois que as correções estiverem rodando, o worker mantém o
 * estado sozinho e este script não tem mais o que fazer.
 *
 * ## O que ele arruma
 *
 * **1. Follow-up `pendente` com as tentativas esgotadas.** `vencidos()`
 * filtra `tentativas < 3`, então a fila nunca mais pega essas linhas — mas
 * elas continuavam `pendente`, e `rodadaDeSilencio` devolve `null` diante
 * de qualquer pendente. Cada uma dessas linhas é um lead proibido de
 * receber follow-up para sempre. Elas passam a `falhou`, que é o que
 * sempre deveriam ter sido: a régua volta a contá-las como rodada gasta,
 * sem ficar travada nelas.
 *
 * **2. Lead que já devia estar `perdido`.** `encerrarSemResposta` lia 50
 * linhas sem ordenação e sem filtrar lead fechado, então a leitura vinha
 * quase toda de trabalho já feito e a fila real nunca era alcançada. Aqui
 * a mesma regra roda sobre o conjunto inteiro, uma vez.
 *
 * A regra de encerramento é lida do worker, não reescrita: duas definições
 * de "lead perdido por silêncio" no mesmo sistema é a forma mais rápida de
 * as duas discordarem. Este script só remove o teto e a ordenação ruim.
 *
 * ## O que ele NÃO faz
 *
 * Não manda mensagem nenhuma. Não devolve handoff — para isso existe
 * `POST /api/followups/handoffs-mudos`, que também simula por padrão.
 * Não mexe na trilha de relacionamento.
 *
 * ## O padrão é SIMULAR
 *
 * Ao contrário dos outros scripts daqui, que gravam e aceitam `--dry`.
 * A inversão é deliberada: este mexe em dezenas de leads de uma vez, e em
 * 31/08/2026 um `--dry` mal colocado reclassificou 9 leads sem querer.
 * Quando a ação em lote é irreversível na prática, o comando curto tem que
 * ser o inofensivo.
 *
 * Uso:
 *   npm run regularizar             # só mostra o que faria
 *   npm run regularizar -- --valendo
 */
import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { funil } from '../src/services/funil.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const valendo = args.includes('--valendo');
const DIA = 24 * 60 * 60 * 1000;
const MORTAS = new Set(['ganho', 'perdido', 'finalizado']);

console.log(valendo
  ? '⚠️  MODO VALENDO — as mudanças serão gravadas.\n'
  : 'Simulação. Nada será gravado. Rode com --valendo para aplicar.\n');

// ──────────────────────────────────────────────
// 1. Follow-ups pendentes com tentativas esgotadas
// ──────────────────────────────────────────────

const { data: travados, error: erroTravados } = await supabase
  .from('crm_followups')
  .select('id, lead_id, tipo, scheduled_for, tentativas, erro')
  .eq('status', 'pendente')
  .gte('tentativas', 3)
  .order('scheduled_for', { ascending: true });

if (erroTravados) {
  console.error('Falha ao ler os follow-ups travados:', erroTravados.message);
  process.exit(1);
}

console.log(`── Follow-ups pendentes travados: ${travados?.length || 0}`);
for (const f of travados || []) {
  const dias = Math.floor((Date.now() - new Date(f.scheduled_for).getTime()) / DIA);
  console.log(
    `   lead ${String(f.lead_id).padEnd(5)} ${f.tipo.padEnd(12)} ` +
    `vencido há ${String(dias).padStart(3)}d — ${String(f.erro || 'sem erro').slice(0, 60)}`
  );
}

if (valendo && travados?.length) {
  const { error } = await supabase
    .from('crm_followups')
    .update({ status: 'falhou' })
    .in('id', travados.map(f => f.id));

  if (error) console.error('   Falha ao destravar:', error.message);
  else console.log(`   → ${travados.length} linha(s) marcada(s) como "falhou".`);
}
console.log('');

// ──────────────────────────────────────────────
// 2. Leads que já deviam estar perdidos
// ──────────────────────────────────────────────

const dias = config.followup.diasAtePerdido;

if (!dias || dias <= 0) {
  console.log('── Encerramento automático desligado (FOLLOWUP_DIAS_ATE_PERDIDO=0). Nada a fazer.');
  process.exit(0);
}

const limite = new Date(Date.now() - dias * DIA).toISOString();

const { data: rodadas, error: erroRodadas } = await supabase
  .from('crm_followups')
  .select('lead_id, tipo, sent_at, lead:crm_leads!inner ( id, full_name, stage, trilha, contact_id )')
  .in('tipo', ['sondagem_2', 'silencio_2'])
  .eq('status', 'enviado')
  .lte('sent_at', limite)
  .not('lead.stage', 'in', funil.FILTRO_ETAPAS_FECHADAS)
  .order('sent_at', { ascending: true });

if (erroRodadas) {
  console.error('Falha ao ler as segundas rodadas:', erroRodadas.message);
  process.exit(1);
}

console.log(`── Segundas rodadas enviadas há ${dias}d+ com o lead ainda aberto: ${rodadas?.length || 0}`);

const aFechar = [];
let responderam = 0, foraDaVenda = 0;

for (const f of rodadas || []) {
  const lead = f.lead;
  if (!lead || MORTAS.has(lead.stage)) continue;

  if ((lead.trilha || 'lead') !== 'lead') { foraDaVenda++; continue; }
  if (!lead.contact_id) continue;

  // Mesma pergunta do worker, e pela mesma razão: só uma mensagem DELE
  // conta como resposta. `last_activity_at` é encostado por mudança de
  // etapa e por envio nosso, e usá-lo isentava do encerramento quem nunca
  // respondeu nada.
  const { data: resposta } = await supabase
    .from('wa_messages')
    .select('id')
    .eq('contact_id', lead.contact_id)
    .eq('direction', 'inbound')
    .gt('created_at', f.sent_at)
    .limit(1);

  if (resposta?.length) { responderam++; continue; }

  if (aFechar.some(a => a.id === lead.id)) continue;
  aFechar.push({
    id: lead.id,
    nome: lead.full_name,
    stage: lead.stage,
    tipo: f.tipo,
    diasDesde: Math.floor((Date.now() - new Date(f.sent_at).getTime()) / DIA),
  });
}

console.log(`   responderam depois da última rodada: ${responderam}`);
console.log(`   saíram da trilha de venda: ${foraDaVenda}`);
console.log(`   a encerrar como "perdido": ${aFechar.length}\n`);

for (const l of aFechar) {
  console.log(
    `   lead ${String(l.id).padEnd(5)} ${String(l.nome || 'sem nome').slice(0, 28).padEnd(30)} ` +
    `${l.stage.padEnd(22)} ${l.tipo} há ${l.diasDesde}d`
  );
}

if (valendo && aFechar.length) {
  console.log('');
  let ok = 0;
  for (const l of aFechar) {
    try {
      await funil.mudarEtapa(l.id, 'perdido', {
        actor: 'sistema',
        motivo: `Sem resposta ${l.diasDesde} dia(s) depois da segunda rodada de follow-up`,
        campos: { lost_reason: 'Sem resposta após duas rodadas de follow-up' },
      });
      ok++;
    } catch (err) {
      console.error(`   lead ${l.id}: ${err.message}`);
    }
  }
  console.log(`   → ${ok} lead(s) encerrado(s) como perdido.`);
}

console.log('');
if (!valendo) console.log('Nada foi gravado. Rode com --valendo para aplicar.');
