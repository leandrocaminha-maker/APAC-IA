/**
 * src/services/gerencia.js
 * O painel gerencial: o que está parado do nosso lado, as aulas
 * experimentais e os desfechos — e os avisos por WhatsApp ao gerente e à
 * coordenação.
 *
 * As decisões estão em `gerencia-regras.js`; aqui se lê o banco e se manda
 * mensagem.
 *
 * ## Onde as coisas ficam
 *
 * Em `crm_controle`, sem tabela nova: a configuração em `gerencia:config`
 * e o que já foi avisado em `gerencia:avisados` (chave → quando). Uma
 * migration a mais é uma chance a mais de o código rodar contra um banco
 * que não a tem.
 *
 * ## Os números da equipe ficam fora do funil
 *
 * Quem recebe aviso pode responder pelo WhatsApp. Sem cuidado, a resposta
 * do gerente abriria um lead de venda e a Leia responderia a ele — e o eco
 * do próprio aviso seria lido como "consultor escrevendo do aparelho". O
 * webhook pergunta `ehDestinatario` antes do funil, nos dois sentidos.
 */
import { config as configApp } from '../config.js';
import { supabase, lerTodas } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { controle } from './controle.js';
import { sendText } from './evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from './contacts.js';
import { evoClient } from './evo-client.js';
import {
  CONFIG_PADRAO, TIPOS_ALERTA, EVENTOS_AULA, DESTINOS, DIAS_SEMANA, AVISO_ATE_DIAS,
  normalizarConfig, alertasDe, avisosDeAula, regrasQueCasam, mensagemDoCiclo,
  dentroDoHorario, idadeNaData, telefoneDaEquipe,
} from './gerencia-regras.js';

const CHAVE_CONFIG = 'gerencia:config';
const CHAVE_AVISADOS = 'gerencia:avisados';
export const SENT_BY_GERENCIA = 'bot:gerencia';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const ENCERRADAS = '(ganho,perdido,finalizado)';

// ──────────────────────────────────────────────
// Configuração
// ──────────────────────────────────────────────

let cacheConfig = { valor: null, em: 0 };

export async function carregarConfig({ fresca = false } = {}) {
  if (!fresca && cacheConfig.valor && Date.now() - cacheConfig.em < 60_000) return cacheConfig.valor;
  const marca = await controle.lerMarcador(CHAVE_CONFIG);
  const valor = normalizarConfig(marca?.valor && Object.keys(marca.valor).length ? marca.valor : CONFIG_PADRAO);
  cacheConfig = { valor, em: Date.now() };
  return valor;
}

export async function salvarConfig(entrada, usuario = null) {
  const valor = normalizarConfig(entrada);
  const ok = await controle.carimbarMarcador(CHAVE_CONFIG, valor);
  if (!ok) throw new Error('Não foi possível gravar a configuração.');
  cacheConfig = { valor, em: Date.now() };
  logger.info(`[gerencia] Configuração gravada${usuario ? ` por ${usuario.nome || usuario.email}` : ''} — ` +
    `avisos ${valor.avisos.ligado ? 'ligados' : 'desligados'}, ${valor.aulas.regras.filter(r => r.ativa).length} regra(s) de aula ativa(s)`);
  return valor;
}

/** Este telefone recebe avisos do painel? É a pergunta que tira a equipe do funil. */
export async function ehDestinatario(telefone) {
  const n = telefoneDaEquipe(telefone);
  if (!n) return false;
  const c = await carregarConfig().catch(() => null);
  return !!c && (c.avisos.gerente.includes(n) || c.avisos.coordenacao.includes(n));
}

// ──────────────────────────────────────────────
// Leitura
// ──────────────────────────────────────────────

function quem(m) {
  if (m.direction === 'inbound') return 'cliente';
  const s = String(m.sent_by || '');
  if (s === 'bot') return 'leia';
  if (s === 'bot:followup') return 'followup';
  if (s.startsWith('human:')) return 'consultor';
  return null;   // campanha, apps irmãos, acompanhamento, avisos: não são conversa de venda
}

async function nomesDosConsultores() {
  const { data } = await supabase.from('crm_users').select('id, name');
  return new Map((data || []).map(u => [u.id, u.name]));
}

/**
 * As mensagens dos contatos (90 dias), resumidas por contato: a última de
 * conversa de venda e quem falou nosso antes da última do cliente. O texto
 * só é buscado para as últimas — é a parte pesada da leitura.
 */
async function resumoDasMensagens(contatos) {
  const desde = new Date(Date.now() - 90 * DIA_MS).toISOString();
  const porContato = new Map();
  const unicos = [...new Set(contatos.filter(Boolean))];

  for (let i = 0; i < unicos.length; i += 60) {
    const { data, error } = await lerTodas(() => supabase
      .from('wa_messages')
      .select('id, contact_id, direction, sent_by, created_at')
      .in('contact_id', unicos.slice(i, i + 60))
      .gte('created_at', desde));
    if (error) throw new Error(`mensagens: ${error.message}`);
    for (const m of data) {
      const q = quem(m);
      if (!q) continue;
      (porContato.get(m.contact_id) || porContato.set(m.contact_id, []).get(m.contact_id)).push({ ...m, quem: q });
    }
  }

  const resumo = new Map();
  const ids = [];
  for (const [contato, lista] of porContato) {
    lista.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const ultima = lista[lista.length - 1];
    let ultimaNossaAntes = null;
    if (ultima.quem === 'cliente') {
      const antes = [...lista].reverse().find(m => m.quem !== 'cliente');
      ultimaNossaAntes = antes?.quem || null;
    }
    resumo.set(contato, { ultima: { quem: ultima.quem, em: ultima.created_at, id: ultima.id, texto: '' }, ultimaNossaAntes });
    ids.push(ultima.id);
  }

  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase.from('wa_messages').select('id, contact_id, content').in('id', ids.slice(i, i + 150));
    for (const m of data || []) {
      const r = resumo.get(m.contact_id);
      if (r && r.ultima.id === m.id) r.ultima.texto = String(m.content || '');
    }
  }
  return resumo;
}

async function statusDasConversas(contatos) {
  const status = new Map();
  const unicos = [...new Set(contatos.filter(Boolean))];
  for (let i = 0; i < unicos.length; i += 150) {
    const { data } = await supabase
      .from('wa_conversations')
      .select('contact_id, status, started_at')
      .in('contact_id', unicos.slice(i, i + 150))
      .neq('channel', 'web-test')
      .order('started_at', { ascending: true });
    for (const c of data || []) status.set(c.contact_id, c.status);
  }
  return status;
}

const CAMPOS_LEAD = 'id, contact_id, full_name, phone, stage, stage_since, owner_user_id, birth_date, ' +
  'experimental_at, experimental_status, experimental_activity, metadata, next_action_at, next_action_note, ' +
  'sale_at, sale_value, lost_reason, evo_id_prospect, trilha';

/** Tudo o que o painel e os avisos precisam, numa passada. */
async function lerDados({ dias = 30, agora = new Date() } = {}) {
  const consultores = await nomesDosConsultores();
  const desdePeriodo = new Date(agora.getTime() - dias * DIA_MS).toISOString();
  const desdeAulas = new Date(agora.getTime() - Math.max(dias, 14) * DIA_MS).toISOString();
  const ateAulas = new Date(agora.getTime() + 14 * DIA_MS).toISOString();

  const [abertos, comAula, ganhos, perdidos] = await Promise.all([
    lerTodas(() => supabase.from('crm_leads').select(CAMPOS_LEAD)
      .eq('trilha', 'lead').not('stage', 'in', ENCERRADAS)),
    lerTodas(() => supabase.from('crm_leads').select(CAMPOS_LEAD)
      .gte('experimental_at', desdeAulas).lte('experimental_at', ateAulas)),
    lerTodas(() => supabase.from('crm_leads').select(CAMPOS_LEAD)
      .eq('stage', 'ganho').gte('sale_at', desdePeriodo)),
    lerTodas(() => supabase.from('crm_leads').select(CAMPOS_LEAD)
      .eq('stage', 'perdido').gte('stage_since', desdePeriodo)),
  ]);
  for (const r of [abertos, comAula, ganhos, perdidos]) {
    if (r.error) throw new Error(`leads: ${r.error.message}`);
  }

  const [mensagens, conversas] = await Promise.all([
    resumoDasMensagens(abertos.data.map(l => l.contact_id)),
    statusDasConversas(abertos.data.map(l => l.contact_id)),
  ]);

  const consultor = (l) => consultores.get(l.owner_user_id) || null;
  const leadsAbertos = abertos.data.map(l => ({
    ...l,
    consultor: consultor(l),
    conversa_status: conversas.get(l.contact_id) || null,
    ultima: mensagens.get(l.contact_id)?.ultima || null,
    ultimaNossaAntes: mensagens.get(l.contact_id)?.ultimaNossaAntes || null,
  }));

  const ids = comAula.data.map(l => l.id);
  const lembretes = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase.from('crm_followups')
      .select('lead_id, tipo, status, scheduled_for, sent_at')
      .in('lead_id', ids.slice(i, i + 150)).eq('tipo', 'ae_lembrete_24h')
      .order('created_at', { ascending: true });
    for (const f of data || []) lembretes.set(f.lead_id, f);
  }

  const aulas = comAula.data
    .filter(l => (l.trilha || 'lead') === 'lead')
    .map(l => ({
      leadId: l.id,
      nome: l.full_name || 'Sem nome',
      telefone: l.phone,
      idade: idadeNaData(l.birth_date, l.experimental_at),
      atividade: l.experimental_activity,
      experimental_at: l.experimental_at,
      experimental_status: l.experimental_status,
      stage: l.stage,
      consultor: consultor(l),
      lost_reason: l.lost_reason,
      sale_value: l.sale_value,
      lembrete: lembretes.get(l.id) || null,
      evo_id_prospect: l.evo_id_prospect,
      birth_date: l.birth_date,
    }));

  return { leadsAbertos, aulas, ganhos: ganhos.data, perdidos: perdidos.data, desdePeriodo };
}

// ──────────────────────────────────────────────
// Painel
// ──────────────────────────────────────────────

function desfechosDo(dados, agora) {
  const inicio = new Date(dados.desdePeriodo).getTime();
  const passadas = dados.aulas.filter(a => {
    const t = new Date(a.experimental_at).getTime();
    return t >= inicio && t <= agora.getTime();
  });
  const conta = (f) => passadas.filter(f).length;
  const ganhas = conta(a => a.stage === 'ganho');
  const perdidas = conta(a => a.stage === 'perdido');

  const motivos = {};
  for (const l of dados.perdidos) {
    const m = l.lost_reason || 'Sem motivo registrado';
    motivos[m] = (motivos[m] || 0) + 1;
  }

  return {
    aulas: passadas.length,
    comPresenca: conta(a => a.experimental_status === 'realizada' || a.stage === 'experimental_realizada'),
    ganhas,
    perdidas,
    emAberto: passadas.length - ganhas - perdidas - conta(a => a.stage === 'finalizado'),
    conversao: passadas.length ? Math.round((ganhas / passadas.length) * 100) : null,
    vendas: dados.ganhos.length,
    vendasComAula: dados.ganhos.filter(l => l.experimental_at).length,
    receita: Math.round(dados.ganhos.reduce((s, l) => s + Number(l.sale_value || 0), 0) * 100) / 100,
    perdas: dados.perdidos.length,
    motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([motivo, quantos]) => ({ motivo, quantos })),
  };
}

async function atividadesConhecidas() {
  const desde = new Date(Date.now() - 180 * DIA_MS).toISOString();
  const { data } = await lerTodas(() => supabase.from('crm_leads')
    .select('id, experimental_activity').not('experimental_activity', 'is', null).gte('experimental_at', desde));
  const vistas = new Map();
  for (const l of data || []) {
    const nome = String(l.experimental_activity).trim();
    if (nome) vistas.set(nome.toLowerCase(), nome);
  }
  return [...vistas.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** Os dados da tela: alertas, aulas, desfechos, a configuração e os catálogos dela. */
export async function painel({ dias = 30, agora = new Date() } = {}) {
  const periodo = [7, 30, 90].includes(Number(dias)) ? Number(dias) : 30;
  const [config, dados, atividades, avisados] = await Promise.all([
    carregarConfig({ fresca: true }), lerDados({ dias: periodo, agora }), atividadesConhecidas(), lerAvisados(),
  ]);

  const alertas = alertasDe(dados.leadsAbertos, config, agora)
    .map(a => ({ ...a, avisado: !!avisados[a.chave] }));

  const t = agora.getTime();
  const comRegras = (a) => ({ ...a, regras: regrasQueCasam(a, config) });
  const proximas = dados.aulas
    .filter(a => new Date(a.experimental_at).getTime() >= t - 2 * HORA_MS && !['perdido', 'finalizado'].includes(a.stage))
    .sort((a, b) => new Date(a.experimental_at) - new Date(b.experimental_at)).map(comRegras);
  const recentes = dados.aulas
    .filter(a => {
      const quando = new Date(a.experimental_at).getTime();
      return quando < t - 2 * HORA_MS && quando >= t - 14 * DIA_MS;
    })
    .sort((a, b) => new Date(b.experimental_at) - new Date(a.experimental_at)).map(comRegras);

  return {
    geradoEm: agora.toISOString(),
    dias: periodo,
    alertas,
    aulas: { proximas, recentes },
    desfechos: desfechosDo(dados, agora),
    abertos: dados.leadsAbertos.length,
    config,
    catalogos: {
      tipos: TIPOS_ALERTA, eventos: EVENTOS_AULA, destinos: DESTINOS, diasSemana: DIAS_SEMANA,
      atividades, avisoAteDias: AVISO_ATE_DIAS,
    },
  };
}

// ──────────────────────────────────────────────
// Avisos por WhatsApp
// ──────────────────────────────────────────────

async function lerAvisados() {
  const marca = await controle.lerMarcador(CHAVE_AVISADOS);
  return marca?.valor || {};
}

async function gravarAvisados(avisados, agora) {
  const corte = agora.getTime() - 45 * DIA_MS;
  const vivos = Object.fromEntries(Object.entries(avisados).filter(([, quando]) => new Date(quando).getTime() >= corte));
  await controle.carimbarMarcador(CHAVE_AVISADOS, vivos);
}

/**
 * Manda pela Leia e grava na conversa daquele número, como `bot:gerencia`.
 * Gravar é o que permite ao webhook reconhecer o eco e ao painel mostrar o
 * que saiu. O aviso NÃO entra no teto diário do número: é para a equipe.
 */
async function enviarParaEquipe(telefone, texto) {
  const r = await sendText(telefone, texto);
  try {
    const contato = await getOrCreateContact(telefone);
    const conversa = await getOrCreateConversation(contato.id);
    await saveMessage({
      conversationId: conversa.id,
      contactId: contato.id,
      direction: 'outbound',
      content: texto,
      sentBy: SENT_BY_GERENCIA,
      evolutionMsgId: r?.key?.id || null,
      status: 'sent',
      metadata: { gerencia: true },
    });
  } catch (err) {
    logger.warn(`[gerencia] Aviso enviado a ${telefone}, mas não gravado: ${err.message}`);
  }
}

/**
 * Completa a idade das aulas que casariam uma regra por idade, pelo
 * nascimento do cadastro no EVO — o cadastro feito no balcão é do aluno (a
 * criança), e o lead não tinha a data. Grava no lead para não perguntar de
 * novo. No máximo `limite` por ciclo.
 */
async function completarIdades(aulas, config, limite = 8) {
  const precisa = config.aulas.regras.some(r => r.ativa && (r.idadeMin != null || r.idadeMax != null));
  if (!precisa) return;
  let feitas = 0;
  for (const a of aulas) {
    if (feitas >= limite) break;
    if (a.idade != null || a.birth_date || !(Number(a.evo_id_prospect) > 0)) continue;
    feitas++;
    try {
      const p = await evoClient.buscarProspectPorId(a.evo_id_prospect);
      const nascimento = String(p?.birthDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) continue;
      await supabase.from('crm_leads').update({ birth_date: nascimento }).eq('id', a.leadId).is('birth_date', null);
      a.birth_date = nascimento;
      a.idade = idadeNaData(nascimento, a.experimental_at);
    } catch (err) {
      logger.warn(`[gerencia] Nascimento do cadastro ${a.evo_id_prospect} não lido: ${err.message}`);
    }
  }
}

/**
 * Um ciclo de avisos: o que é novo desde o último, uma mensagem por pessoa.
 *
 * Alerta com mais de `AVISO_ATE_DIAS` aparece no painel e não vira
 * mensagem — ligar os avisos não pode despejar o passado inteiro no
 * WhatsApp do gerente.
 */
export async function avisar({ agora = new Date() } = {}) {
  const config = await carregarConfig({ fresca: true });
  const { gerente, coordenacao, ligado } = config.avisos;
  if (!ligado) return { enviados: 0, motivo: 'avisos desligados' };
  if (!gerente.length && !coordenacao.length) return { enviados: 0, motivo: 'ninguém para avisar' };
  if (!dentroDoHorario(agora, config.avisos)) return { enviados: 0, motivo: 'fora do horário' };

  const dados = await lerDados({ dias: 14, agora });
  await completarIdades(dados.aulas, config);

  const avisados = await lerAvisados();
  const recente = (a) => agora.getTime() - new Date(a.desde).getTime() <= AVISO_ATE_DIAS * DIA_MS;
  const alertas = alertasDe(dados.leadsAbertos, config, agora).filter(a => recente(a) && !avisados[a.chave]);
  const aulas = avisosDeAula(dados.aulas, config, agora).filter(a => !avisados[a.chave]);

  const pacotes = [
    { telefones: gerente, alertas, aulas: aulas.filter(a => a.destino !== 'coordenacao') },
    { telefones: coordenacao, alertas: [], aulas: aulas.filter(a => a.destino !== 'gerente') },
  ];

  const link = `${configApp.crm.urlPublica.replace(/\/$/, '')}/crm`;
  let enviados = 0;
  for (const p of pacotes) {
    if (!p.telefones.length) continue;
    const texto = mensagemDoCiclo({ alertas: p.alertas, aulas: p.aulas, link }, agora);
    if (!texto) continue;
    let saiu = false;
    for (const tel of p.telefones) {
      try {
        await enviarParaEquipe(tel, texto);
        enviados++;
        saiu = true;
      } catch (err) {
        logger.error(`[gerencia] Aviso para ${tel} falhou: ${err.message}`);
      }
    }
    if (saiu) for (const item of [...p.alertas, ...p.aulas]) avisados[item.chave] = agora.toISOString();
  }

  if (enviados) {
    await gravarAvisados(avisados, agora);
    logger.info(`[gerencia] ${enviados} aviso(s) enviado(s): ${alertas.length} situação(ões), ${aulas.length} aula(s)`);
  }
  return { enviados, alertas: alertas.length, aulas: aulas.length };
}

/** Uma mensagem de teste para cada número configurado. */
export async function enviarTeste() {
  const config = await carregarConfig({ fresca: true });
  const destinos = [
    ...config.avisos.gerente.map(t => ({ t, papel: 'gerente' })),
    ...config.avisos.coordenacao.map(t => ({ t, papel: 'coordenação' })),
  ];
  if (!destinos.length) throw new Error('Nenhum número cadastrado para receber avisos.');
  const resultado = [];
  for (const { t, papel } of destinos) {
    try {
      await enviarParaEquipe(t,
        `*Painel gerencial — AP Academia*\nTeste: este número recebe os avisos como ${papel}. ` +
        'Não precisa responder.');
      resultado.push({ telefone: t, ok: true });
    } catch (err) {
      resultado.push({ telefone: t, ok: false, erro: err.message });
    }
  }
  return { resultado };
}

export const gerencia = {
  carregarConfig, salvarConfig, ehDestinatario, painel, avisar, enviarTeste, SENT_BY_GERENCIA,
};
