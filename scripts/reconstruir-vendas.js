/**
 * Reconstrução do registro de vendas e dos ganhos do funil.
 *
 * Não é rotina: é o acerto de uma vez do histórico, com a MESMA regra que o
 * webhook passou a usar em 26/10/2026 (src/services/vendas.js). Depois dele,
 * o webhook mantém tudo em dia sozinho.
 *
 * ## O que ele faz
 *
 * **1. Toda venda de plano pago guardada** (`NewSale` desde o começo dos
 * webhooks), em ordem de data: classifica (novo, ex-aluno, aluno ativo;
 * WhatsApp ou balcão; vendedor), grava em `crm_vendas` e aplica no
 * atendimento — vira ganho, recebe o valor que faltava, ou só fica ligada.
 * É aqui que entram as vendas que o painel perdia: a do balcão chegava com
 * o número de aluno novo e não achava o lead.
 *
 * **2. Ganhos que não têm venda de plano nenhuma**: se o ganho veio do
 * webhook por uma compra sem plano (touca, maiô, venda vazia), ele é
 * corrigido. Quando a pessoa já tem um atendimento mais novo — onde a
 * conversa continuou —, este vira perdido com a explicação; senão, volta à
 * etapa em que estava. Ganho de outra origem (conversão vista pelo poller,
 * venda registrada pelo painel) não é tocado, só listado.
 *
 * **3. Conversas pós-aula pendentes** no horário antigo (4h depois da
 * aula): passam para a manhã seguinte, que é quando o aviso de presença do
 * EVO já chegou.
 *
 * **4. Avisos das automações do CRM** ("aula experimental realizada",
 * "cadastro de oportunidade") que chegaram antes do deploy e foram
 * guardados sem efeito: processados agora.
 *
 * ## O que ele NÃO faz
 *
 * Não manda mensagem nenhuma. Os atendimentos que viram ganho têm os
 * follow-ups cancelados, como qualquer ganho.
 *
 * ## Consultas ao EVO
 *
 * O histórico de contratos e o celular de cada comprador ficam guardados na
 * pasta de cache (`--cache`). A simulação busca e guarda; a rodada
 * `--valendo` reaproveita, sem perguntar de novo. Uma consulta por segundo,
 * para não disputar a cota com a Leia.
 *
 * ## O padrão é SIMULAR
 *
 * Mesmo motivo do `regularizar-parados.js`: mexe em dezenas de leads de uma
 * vez, e o comando curto tem que ser o inofensivo.
 *
 * Uso:
 *   npm run reconstruir-vendas                      # só mostra o que faria
 *   npm run reconstruir-vendas -- --valendo
 *   npm run reconstruir-vendas -- --cache C:/caminho/da/pasta
 *
 * ⚠️ `--valendo` exige a migration 020 aplicada.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supabase, lerTodas } from '../src/lib/supabase.js';
import { config } from '../src/config.js';
import { evoClient } from '../src/services/evo-client.js';
import { funil } from '../src/services/funil.js';
import { followup } from '../src/services/followup.js';
import { vendas } from '../src/services/vendas.js';
import { processarAutomacaoDoCrm } from '../src/services/evo-sync.js';
import { planoDaVenda, telefonesDoMembro, rotuloDoVendedor, dataDoEvo } from '../src/services/vendas-regras.js';

const args = process.argv.slice(2);
const valendo = args.includes('--valendo');
const iCache = args.indexOf('--cache');
const pastaCache = iCache >= 0 && args[iCache + 1]
  ? path.resolve(args[iCache + 1])
  : path.join(os.tmpdir(), 'apac-reconstruir-vendas');
fs.mkdirSync(pastaCache, { recursive: true });

const ETAPAS_FECHADAS = new Set(['ganho', 'perdido', 'finalizado']);
const espera = ms => new Promise(r => setTimeout(r, ms));
const reais = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
const dia = v => String(v || '').slice(0, 10).split('-').reverse().join('/');

console.log(valendo
  ? '⚠️  MODO VALENDO — as mudanças serão gravadas.\n'
  : 'Simulação. Nada será gravado. Rode com --valendo para aplicar.\n');
console.log(`Cache das respostas do EVO: ${pastaCache}`);
console.log(`Ex-aluno: ${config.evo.mesesReativacao} mês(es) ou mais sem contrato (EVO_MESES_REATIVACAO)\n`);

if (valendo) {
  const { error } = await supabase.from('crm_vendas').select('id').limit(1);
  if (error) {
    console.error(`A tabela crm_vendas não responde (${error.code || error.message}). Aplique a migration 020 antes.`);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// O que já está no banco, de uma vez
// ──────────────────────────────────────────────

const { data: leads, error: erroLeads } = await lerTodas(() => supabase
  .from('crm_leads')
  .select('id, contact_id, full_name, phone, stage, stage_since, trilha, tipo_contato, source, created_at, ' +
    'last_activity_at, sale_value, sale_at, evo_id_sale, evo_id_member, evo_id_prospect, experimental_at, experimental_status'));
if (erroLeads) { console.error('Falha ao ler os leads:', erroLeads.message); process.exit(1); }

const { data: eventos, error: erroEventos } = await lerTodas(() => supabase
  .from('crm_evo_webhook_events')
  .select('id, event_type, id_record, detail')
  .in('event_type', ['NewSale', 'CreateMember'])
  .not('detail', 'is', null));
if (erroEventos) { console.error('Falha ao ler os webhooks:', erroEventos.message); process.exit(1); }

const criados = new Map(eventos
  .filter(e => e.event_type === 'CreateMember')
  .map(e => [String(e.id_record), { registerDate: e.detail.registerDate || null, telefones: telefonesDoMembro(e.detail) }]));

const vendasDePlano = eventos
  .filter(e => e.event_type === 'NewSale' && e.detail?.idMember && planoDaVenda(e.detail))
  .sort((a, b) => dataDoEvo(a.detail.saleDate) - dataDoEvo(b.detail.saleDate));

const ganhosAntes = leads.filter(l => l.stage === 'ganho').length;
const perdidosAntes = leads.filter(l => l.stage === 'perdido' && (l.trilha || 'lead') === 'lead').length;

// ──────────────────────────────────────────────
// Fontes: cache em disco para o EVO, memória para o banco
// ──────────────────────────────────────────────

const arquivo = nome => path.join(pastaCache, nome);
const lerJson = nome => fs.existsSync(arquivo(nome)) ? JSON.parse(fs.readFileSync(arquivo(nome), 'utf8')) : {};
const cacheContratos = lerJson('contratos.json');
const cacheMembros = lerJson('membros.json');
const guardarCache = () => {
  fs.writeFileSync(arquivo('contratos.json'), JSON.stringify(cacheContratos));
  fs.writeFileSync(arquivo('membros.json'), JSON.stringify(cacheMembros));
};
let consultas = 0;

let nomes = null;
const fontes = {
  async membroCriado(idMember) { return criados.get(String(idMember)) || null; },

  async contratos(idMember) {
    const id = String(idMember);
    if (!(id in cacheContratos)) {
      const lista = await evoClient.buscarContratosDoMembro(id).catch(() => null);
      consultas++; await espera(1100);
      cacheContratos[id] = lista
        ? lista.map(c => ({ idSale: c.idSale, ini: c.membershipStart, fim: c.cancelDate || c.membershipEnd, valor: c.saleValue }))
        : null;
      guardarCache();
    }
    return cacheContratos[id] || [];
  },

  async telefones(idMember) {
    const id = String(idMember);
    if (!(id in cacheMembros)) {
      const m = await evoClient.buscarMembroPorId(id).catch(() => null);
      consultas++; await espera(1100);
      cacheMembros[id] = m ? { registerDate: m.registerDate, cel: telefonesDoMembro(m) } : null;
      guardarCache();
    }
    return cacheMembros[id]?.cel || [];
  },

  async vendedor(idEmployee) {
    if (idEmployee == null) return null;
    if (!nomes) {
      const lista = await evoClient.listarFuncionarios().catch(() => []);
      consultas++;
      nomes = new Map(lista.map(f => [Number(f.idEmployee), f.name]));
    }
    return rotuloDoVendedor(nomes.get(Number(idEmployee)));
  },

  // A mesma busca de `funil.leadsDaPessoa`, sobre a cópia em memória — que
  // é atualizada a cada venda aplicada, como o banco seria.
  async leadsDaPessoa({ idMember = null, idProspect = null, telefones = [] } = {}) {
    const achados = new Map();
    for (const l of leads) {
      if ((idMember && String(l.evo_id_member) === String(idMember))
        || (idProspect && String(l.evo_id_prospect) === String(idProspect))
        || (l.phone && telefones.includes(l.phone))) achados.set(l.id, l);
    }
    const tels = new Set([...achados.values()].map(l => l.phone).filter(Boolean));
    for (const l of leads) if (l.phone && tels.has(l.phone)) achados.set(l.id, l);
    return [...achados.values()];
  },
};

// ──────────────────────────────────────────────
// 1. As vendas
// ──────────────────────────────────────────────

console.log(`── Vendas de plano pago guardadas: ${vendasDePlano.length} ` +
  `(${dia(vendasDePlano[0]?.detail.saleDate)} a ${dia(vendasDePlano.at(-1)?.detail.saleDate)})`);

const quadro = {};
const acoes = { ganho: [], completar: [], vincular: [] };
const leadsComVenda = new Set();

for (const e of vendasDePlano) {
  const analise = await vendas.analisarVenda(e.detail, { fontes, eventoId: e.id });
  if (!analise) continue;
  const { venda, escolha } = analise;

  const k = `${venda.comprador.padEnd(11)} | ${venda.canal}`;
  quadro[k] ??= { vendas: 0, valor: 0 };
  quadro[k].vendas++;
  quadro[k].valor += venda.valor;

  if (escolha) {
    const l = escolha.lead;
    leadsComVenda.add(l.id);
    acoes[escolha.acao].push({
      lead: l.id, antes: `${l.stage}${(l.trilha || 'lead') === 'lead' ? '' : ' (relacionamento)'}`,
      venda: venda.evo_id_sale, data: dia(venda.sale_at), valor: venda.valor,
      plano: venda.planos[0], comprador: venda.comprador,
    });
  }

  if (valendo) {
    await vendas.gravarVenda(venda);
    await vendas.aplicarNoLead(analise, { actor: 'sistema' });
  }

  // A cópia em memória acompanha o que a venda fez, para a próxima venda
  // da mesma pessoa decidir sobre o estado certo.
  if (escolha?.acao === 'ganho') {
    Object.assign(escolha.lead, {
      stage: 'ganho', trilha: 'lead', sale_value: venda.valor, sale_at: venda.sale_at,
      evo_id_sale: venda.evo_id_sale, evo_id_member: escolha.lead.evo_id_member || venda.evo_id_member,
    });
  } else if (escolha?.acao === 'completar') {
    Object.assign(escolha.lead, { sale_value: venda.valor, sale_at: venda.sale_at, evo_id_sale: venda.evo_id_sale });
  }
}

console.log('');
console.log('   comprador   | canal      vendas        valor');
for (const k of Object.keys(quadro).sort()) {
  console.log(`   ${k.padEnd(22)} ${String(quadro[k].vendas).padStart(5)}  ${reais(quadro[k].valor).padStart(13)}`);
}

const listar = (titulo, linhas) => {
  console.log(`\n── ${titulo}: ${linhas.length}`);
  for (const a of linhas) {
    console.log(`   lead ${String(a.lead).padEnd(5)} ${a.antes.padEnd(36)} venda ${a.venda} de ${a.data}  ` +
      `${reais(a.valor).padStart(12)}  ${a.comprador.padEnd(11)} ${String(a.plano).slice(0, 40)}`);
  }
};
listar('Atendimentos que viram ganho', acoes.ganho);
listar('Ganhos que recebem o valor que faltava', acoes.completar);
listar('Vendas ligadas a um ganho que já tinha valor (outro plano da mesma família)', acoes.vincular);

// ──────────────────────────────────────────────
// 2. Ganhos sem venda de plano
// ──────────────────────────────────────────────

const semVenda = leads.filter(l => l.stage === 'ganho' && !leadsComVenda.has(l.id) && l.sale_value == null);
const correcoes = [];
const mantidos = [];

for (const l of semVenda) {
  const { data: ev } = await supabase
    .from('crm_lead_events')
    .select('actor, stage_from, payload, occurred_at')
    .eq('lead_id', l.id).eq('type', 'stage_change').eq('stage_to', 'ganho')
    .order('occurred_at', { ascending: false }).limit(1);
  const fecho = ev?.[0];

  // Só o ganho que o webhook deu por uma compra sem plano é falso.
  const falso = fecho?.actor === 'evo-webhook' && !planoDaVenda(fecho.payload?.detalhe);
  if (!falso) { mantidos.push({ lead: l.id, por: fecho?.actor || '?' }); continue; }

  const itens = (fecho.payload?.detalhe?.saleItens || []).map(i => String(i.description || '').slice(0, 30)).join(' + ') || 'venda sem itens';
  const mesmaPessoa = (o) => o.id !== l.id && ((l.contact_id && o.contact_id === l.contact_id) || (l.phone && o.phone === l.phone));
  const maisNovo = leads.filter(o => mesmaPessoa(o) && new Date(o.created_at) > new Date(l.created_at))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  correcoes.push({ lead: l, de: dia(fecho.occurred_at), itens, maisNovo, voltaPara: fecho.stage_from });
}

console.log(`\n── Ganhos sem venda de plano: ${semVenda.length}`);
for (const c of correcoes) {
  console.log(`   lead ${String(c.lead.id).padEnd(5)} fechado em ${c.de} por "${c.itens}" → ` +
    (c.maisNovo ? `perdido (a conversa seguiu no lead ${c.maisNovo.id}, hoje ${c.maisNovo.stage})` : `volta para ${c.voltaPara}`));
}
for (const m of mantidos) console.log(`   lead ${String(m.lead).padEnd(5)} mantido como ganho (fechado por ${m.por})`);

if (valendo) {
  for (const c of correcoes) {
    const motivo = `Correção de 26/10/2026: o ganho veio de uma compra sem plano (${c.itens}), não de uma venda.`;
    try {
      if (c.maisNovo) {
        await funil.mudarEtapa(c.lead, 'perdido', {
          actor: 'sistema',
          motivo,
          campos: {
            sale_value: null, sale_at: null, evo_id_sale: null,
            lost_reason: `${motivo} A conversa seguiu no lead ${c.maisNovo.id}.`,
          },
        });
      } else {
        // Volta à etapa de antes sem parecer atividade nova: a varredura de
        // silêncio olha `last_activity_at`, e uma data de hoje faria a Leia
        // escrever para alguém parado há semanas.
        await funil.mudarEtapa(c.lead, c.voltaPara || 'com_consultor', {
          actor: 'sistema', motivo, campos: { sale_value: null, sale_at: null, evo_id_sale: null },
        });
        await supabase.from('crm_leads').update({ last_activity_at: c.lead.last_activity_at }).eq('id', c.lead.id);
      }
    } catch (err) {
      console.error(`   lead ${c.lead.id}: ${err.message}`);
    }
  }
}
// A cópia em memória também, para o resultado abaixo valer nas duas rodadas.
for (const c of correcoes) {
  Object.assign(c.lead, { stage: c.maisNovo ? 'perdido' : (c.voltaPara || 'com_consultor'), sale_value: null });
}

// ──────────────────────────────────────────────
// 3. Conversas pós-aula pendentes
// ──────────────────────────────────────────────

const { data: posAula } = await supabase
  .from('crm_followups')
  .select('id, lead_id, scheduled_for, contexto')
  .eq('tipo', 'ae_pos_aula').eq('status', 'pendente');

const remarcar = (posAula || [])
  .filter(f => f.contexto?.aula)
  .map(f => ({ ...f, novo: followup.horarioDoPosAula(new Date(f.contexto.aula)) }))
  .filter(f => Math.abs(f.novo - new Date(f.scheduled_for)) > 60 * 1000);

console.log(`\n── Conversas pós-aula pendentes no horário antigo: ${remarcar.length}`);
for (const f of remarcar) {
  console.log(`   lead ${String(f.lead_id).padEnd(5)} ${f.scheduled_for} → ${f.novo.toISOString()}`);
  if (valendo) await supabase.from('crm_followups').update({ scheduled_for: f.novo.toISOString() }).eq('id', f.id);
}

// ──────────────────────────────────────────────
// 4. Avisos das automações do CRM guardados sem regra
//
// Os de "aula experimental realizada" e "cadastro de oportunidade" que
// chegaram antes do deploy foram guardados pelo código antigo sem efeito.
// Só os ainda sem lead: os já ligados não são processados de novo.
// ──────────────────────────────────────────────

const { data: avisos } = await supabase
  .from('crm_evo_webhook_events')
  .select('id, event_type, payload, created_at')
  .or('event_type.like.%trial_class_completed,event_type.like.%prospect_registration')
  .is('lead_id', null)
  .order('id');

console.log(`\n── Avisos de automação do CRM ainda sem atendimento: ${avisos?.length || 0}`);
for (const a of avisos || []) {
  const p = a.payload?.person || {};
  console.log(`   ${a.event_type.replace('crm.automation.', '')} de ${dia(a.created_at)} — ${p.fullName || 'sem nome'}`);
  if (valendo) {
    const lead = await processarAutomacaoDoCrm(a.event_type, a.payload);
    if (lead?.id) await supabase.from('crm_evo_webhook_events').update({ lead_id: lead.id }).eq('id', a.id);
  }
}

// ──────────────────────────────────────────────
// Resultado
// ──────────────────────────────────────────────

const ganhosDepois = leads.filter(l => l.stage === 'ganho').length;
const perdidosDepois = leads.filter(l => l.stage === 'perdido' && (l.trilha || 'lead') === 'lead').length;
const receitaDepois = leads.filter(l => l.stage === 'ganho').reduce((s, l) => s + Number(l.sale_value || 0), 0);
const conv = (g, p) => g + p ? `${(g / (g + p) * 100).toFixed(1).replace('.', ',')}%` : '—';

console.log('\n── Resultado no funil (atendimentos de venda)');
console.log(`   ganhos:   ${ganhosAntes} → ${ganhosDepois}`);
console.log(`   perdidos: ${perdidosAntes} → ${perdidosDepois}`);
console.log(`   receita dos ganhos: ${reais(receitaDepois)}`);
console.log(`   conversão sobre decididos: ${conv(ganhosAntes, perdidosAntes)} → ${conv(ganhosDepois, perdidosDepois)}`);
console.log(`\nConsultas ao EVO nesta rodada: ${consultas}`);
if (!valendo) console.log('Nada foi gravado. Rode com --valendo para aplicar.');
process.exit(0);
