/**
 * Limpeza de uma vez do funil de venda aberto (29/10/2026).
 *
 * O painel mostrava 254 atendimentos "com a Leia e consultores", e a
 * verificação desse dia achou o motivo: quase nada se fechava. Este script
 * fecha o que ficou para trás. Daqui em diante, o encerramento automático
 * (a fila corrigida em `followup-worker.js`) e o webhook (que descarta a
 * cópia pelo identificador oculto) mantêm o estado.
 *
 * ## O que ele fecha
 *
 * **1. Fantasmas e testes → finalizado, fora da venda.** Atendimento cujo
 * "telefone" não é número:
 *   - `teste-…`: conversa da página de teste da Leia;
 *   - identificador oculto do WhatsApp (`…@lid`) em que TODA mensagem
 *     recebida também entrou, com o mesmo id, pelo número real da pessoa —
 *     a conversa de verdade é a do outro contato.
 * O contato vira "outro", o atendimento vai para o relacionamento e é
 * finalizado. Não conta como venda perdida, porque não era venda.
 * Identificador oculto com mensagem própria (há quem converse só por ele)
 * não é tocado.
 *
 * **2. Travados → perdido.** Atendimento de venda aberto em que a última
 * mensagem é NOSSA (Leia, follow-up ou consultor) e tem mais de `--dias`
 * (14). São os que a régua deixou para trás: quem respondeu ao
 * encerramento e sumiu de novo, e quem saiu da janela de 7 dias da régua
 * sem ter sido cutucado. Ficam de fora:
 *   - aula marcada para o futuro, ou aula vendida esperando reserva;
 *   - follow-up pendente;
 *   - "aguardando consultor" (handoff que ninguém pegou é assunto da equipe);
 *   - encerramento enviado e sem resposta — o worker fecha esses com o
 *     motivo dele.
 *
 * ## O que ele NÃO fecha
 *
 * Atendimento em que o CLIENTE falou por último. Pode ser só um "obrigada",
 * pode ser pergunta sem resposta: quem decide é gente, pelo painel
 * gerencial. O script só conta quantos são.
 *
 * Não manda mensagem nenhuma.
 *
 * ## O padrão é SIMULAR
 *
 * Mesmo motivo do `regularizar-parados.js`: ação em lote irreversível na
 * prática exige a palavra a mais.
 *
 * Uso:
 *   node scripts/limpar-funil.js               # só mostra o que faria
 *   node scripts/limpar-funil.js --valendo
 *   node scripts/limpar-funil.js --dias=21
 */
import 'dotenv/config';
import { lerTodas, supabase } from '../src/lib/supabase.js';
import { funil, FILTRO_ETAPAS_FECHADAS } from '../src/services/funil.js';

const args = process.argv.slice(2);
const valendo = args.includes('--valendo');
const dias = Number((args.find(a => a.startsWith('--dias=')) || '').split('=')[1]) || 14;
const AGORA = Date.now();
const DIA = 24 * 60 * 60 * 1000;

const numeroValido = (f) => /^55\d{10,11}$/.test(String(f || ''));
const curta = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function quem(m) {
  if (m.direction === 'inbound') return 'cliente';
  const s = String(m.sent_by || '');
  if (s === 'bot' || s === 'bot:followup' || s.startsWith('human:')) return 'nos';
  return 'outro';   // campanha, apps irmãos, acompanhamento: não contam
}

// ── Leitura ───────────────────────────────────
const { data: leads, error } = await lerTodas(() => supabase
  .from('crm_leads')
  .select('id, contact_id, full_name, phone, stage, trilha, experimental_at, metadata')
  .not('stage', 'in', FILTRO_ETAPAS_FECHADAS));
if (error) {
  console.error('Falha ao ler os leads:', error.message);
  process.exit(1);
}

const contatos = [...new Set(leads.map(l => l.contact_id).filter(Boolean))];
const msgs = new Map();
for (let i = 0; i < contatos.length; i += 40) {
  const { data, error: e } = await lerTodas(() => supabase
    .from('wa_messages')
    .select('id, contact_id, direction, sent_by, content, evolution_msg_id, created_at')
    .in('contact_id', contatos.slice(i, i + 40)));
  if (e) { console.error('Falha ao ler mensagens:', e.message); process.exit(1); }
  for (const m of data) (msgs.get(m.contact_id) || msgs.set(m.contact_id, []).get(m.contact_id)).push(m);
}
for (const lista of msgs.values()) lista.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

const { data: fus } = await lerTodas(() => supabase
  .from('crm_followups')
  .select('id, lead_id, tipo, status, sent_at')
  .in('lead_id', leads.map(l => l.id)));
const fuDo = new Map();
for (const f of fus || []) (fuDo.get(f.lead_id) || fuDo.set(f.lead_id, []).get(f.lead_id)).push(f);

/** O contato que recebeu a mesma mensagem (mesmo id), se houver. */
async function gemeaDe(m, contatoId) {
  if (!m.evolution_msg_id) return null;
  const { data } = await supabase
    .from('wa_messages')
    .select('contact_id')
    .eq('evolution_msg_id', m.evolution_msg_id)
    .eq('direction', 'inbound')
    .neq('contact_id', contatoId)
    .limit(1);
  return data?.[0]?.contact_id ?? null;
}

// ── 1. Fantasmas e testes ─────────────────────
const fantasmas = [];
for (const l of leads.filter(l => !numeroValido(l.phone))) {
  if (String(l.phone || '').startsWith('teste')) {
    fantasmas.push({ lead: l, motivo: 'Conversa da página de teste da Leia, não é atendimento' });
    continue;
  }
  const recebidas = (msgs.get(l.contact_id) || []).filter(m => m.direction === 'inbound');
  if (!recebidas.length) continue;
  const gemeas = [];
  for (const m of recebidas) gemeas.push(await gemeaDe(m, l.contact_id));
  if (gemeas.every(Boolean)) {
    fantasmas.push({
      lead: l,
      motivo: `Cópia pelo identificador oculto do WhatsApp: as mensagens são as do contato ${gemeas[0]}, ` +
        'que tem a conversa de verdade',
    });
  }
}
const idsFantasmas = new Set(fantasmas.map(f => f.lead.id));

// ── 2. Travados ───────────────────────────────
const travados = [];
let ultimaDoCliente = 0;
for (const l of leads) {
  if ((l.trilha || 'lead') !== 'lead' || idsFantasmas.has(l.id) || !numeroValido(l.phone)) continue;

  const relevantes = (msgs.get(l.contact_id) || []).filter(m => quem(m) !== 'outro');
  const ultima = relevantes[relevantes.length - 1];
  if (!ultima) continue;
  if (quem(ultima) === 'cliente') {
    if (AGORA - new Date(ultima.created_at) > dias * DIA) ultimaDoCliente++;
    continue;
  }
  if (AGORA - new Date(ultima.created_at) <= dias * DIA) continue;

  if (Date.parse(l.experimental_at || '') > AGORA) continue;
  if (l.metadata?.aula_vendida) continue;
  if (l.stage === 'aguardando_consultor') continue;

  const fu = fuDo.get(l.id) || [];
  if (fu.some(f => f.status === 'pendente')) continue;

  // Encerramento enviado e sem resposta depois: é do worker, com o motivo dele.
  const encerramento = fu
    .filter(f => f.status === 'enviado' && ['silencio_2', 'sondagem_2'].includes(f.tipo))
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
  const ultimaDele = [...relevantes].reverse().find(m => quem(m) === 'cliente');
  if (encerramento && !(ultimaDele && new Date(ultimaDele.created_at) > new Date(encerramento.sent_at))) continue;

  travados.push({ lead: l, ultima });
}

// ── Relatório e gravação ──────────────────────
console.log(`${valendo ? 'VALENDO' : 'SIMULAÇÃO'} — ${leads.length} atendimento(s) aberto(s)\n`);

console.log(`1. Fantasmas e testes → finalizado, fora da venda: ${fantasmas.length}`);
for (const { lead, motivo } of fantasmas) {
  console.log(`   lead ${lead.id} (${lead.phone}, ${lead.stage}) — ${motivo}`);
  if (!valendo) continue;
  await funil.definirTipoDeContato(lead, 'outro', { actor: 'sistema', motivo, forcar: true });
  await funil.mudarEtapa(lead.id, 'finalizado', { actor: 'sistema', motivo });
}

console.log(`\n2. Travados há mais de ${dias} dias, última mensagem nossa → perdido: ${travados.length}`);
const motivoPerda = `Sem resposta do cliente há mais de ${dias} dias`;
for (const { lead, ultima } of travados) {
  console.log(`   lead ${lead.id} (${lead.full_name || 'sem nome'}, ${lead.stage}) — última mensagem nossa em ${curta(ultima.created_at)}`);
  if (!valendo) continue;
  await funil.mudarEtapa(lead.id, 'perdido', {
    actor: 'sistema',
    motivo: `${motivoPerda} (limpeza do funil de 29/10/2026)`,
    campos: { lost_reason: motivoPerda },
  });
}

console.log(`\nNão tocados: ${ultimaDoCliente} atendimento(s) com a última mensagem do CLIENTE há mais de ${dias} dias ` +
  '— ficam para a equipe, no painel gerencial.');
if (!valendo) console.log('\nPara gravar: node scripts/limpar-funil.js --valendo');
