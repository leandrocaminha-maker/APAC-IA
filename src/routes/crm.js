/**
 * src/routes/crm.js
 * O painel do consultor — crm.apacademia.com.br
 *
 * Quatro superfícies, uma autenticação:
 *   funil       → a tabela de gestão de leads (tela principal)
 *   conversas   → histórico de TODAS as conversas, por id, e resposta pelo painel
 *   simulador   → conversar com a Leia sem WhatsApp (herdeiro da /teste)
 *   ajustes     → conexão do WhatsApp, webhooks do EVO, consultores
 *
 * Tudo abaixo de /crm/api exige login de consultor; /crm serve a página.
 * A página é um HTML só, servido estático — o painel é uma ferramenta de
 * time pequeno, e um build de front-end aqui seria peso sem retorno.
 */
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import {
  login, gravarCookie, limparCookie, exigirLogin, exigirAdmin, hashSenha, conferirSenha,
} from '../services/crm-auth.js';
import { funil } from '../services/funil.js';
import { followup } from '../services/followup.js';
import { atendimento } from '../services/atendimento.js';
import { evoSync } from '../services/evo-sync.js';
import { evoClient } from '../services/evo-client.js';
import { aiAgent } from '../services/ai-agent.js';
import { saveMessage, reactivateBot } from '../services/contacts.js';
import {
  sendText, getConnectionStatus, getQrCode, criarInstancia, normalizePhone,
} from '../services/evolution.js';

const router = Router();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PAGINA = join(__dirname, '..', 'public', 'crm.html');

const CANAL_SIMULADOR = 'web-test';

/** Empacota handler async para o erro virar 500 em vez de promise solta. */
function rota(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ──────────────────────────────────────────────
// Página
// ──────────────────────────────────────────────

router.get('/', rota(async (req, res) => {
  if (!config.crm.habilitado) return res.status(404).send('Painel desabilitado.');
  try {
    res.type('html').send(await readFile(PAGINA, 'utf-8'));
  } catch (err) {
    logger.error('[crm] Falha ao ler crm.html:', err.message);
    res.status(500).send('Painel indisponível.');
  }
}));

// ──────────────────────────────────────────────
// Sessão
// ──────────────────────────────────────────────

router.post('/api/entrar', rota(async (req, res) => {
  if (!config.crm.habilitado) return res.status(404).json({ erro: 'Painel desabilitado' });

  const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
  const r = await login(req.body?.email, req.body?.senha, ip);

  if (!r.ok) return res.status(r.status).json({ erro: r.erro });

  gravarCookie(res, r.token);
  res.json({ ok: true, usuario: r.usuario });
}));

router.post('/api/sair', (req, res) => {
  limparCookie(res);
  res.json({ ok: true });
});

// Daqui para baixo, tudo exige login.
router.use('/api', exigirLogin);

router.get('/api/eu', (req, res) => {
  res.json({
    usuario: req.usuario,
    // O painel muda de aparência em dry-run: sem esse aviso, o consultor
    // acha que vendeu e a venda não existe no EVO.
    dryRun: config.evo.dryRun,
  });
});

/**
 * Trocar a própria senha.
 *
 * Pede a senha atual mesmo já havendo sessão válida: o cookie prova que
 * alguém entrou naquele navegador, não que é a pessoa — sem isso, uma
 * máquina destravada vira troca de senha e conta perdida.
 *
 * ⚠️ Trocar a senha **não derruba sessões já abertas**. A sessão é cookie
 * assinado sem store (ver crm-auth.js): não há o que invalidar do lado do
 * servidor sem trocar o segredo, o que derrubaria todo mundo. Para uma
 * senha realmente vazada, o caminho é desativar a conta.
 */
router.post('/api/senha', rota(async (req, res) => {
  const atual = String(req.body?.atual || '');
  const nova = String(req.body?.nova || '');

  if (nova.length < 8) {
    return res.status(400).json({ erro: 'A nova senha precisa de pelo menos 8 caracteres.' });
  }
  if (nova === atual) {
    return res.status(400).json({ erro: 'A nova senha é igual à atual.' });
  }

  const { data: usuario } = await supabase
    .from('crm_users')
    .select('password_hash')
    .eq('id', req.usuario.id)
    .maybeSingle();

  // 403 e não 401: o painel trata 401 como "a sessão morreu" e joga para
  // a tela de login. Errar a senha atual não é sessão inválida — seria
  // deslogar quem só digitou errado.
  if (!usuario || !(await conferirSenha(atual, usuario.password_hash))) {
    logger.warn(`[crm] Senha atual incorreta na troca de ${req.usuario.email}`);
    return res.status(403).json({ erro: 'Senha atual incorreta.' });
  }

  const { error } = await supabase
    .from('crm_users')
    .update({ password_hash: await hashSenha(nova) })
    .eq('id', req.usuario.id);

  if (error) return res.status(500).json({ erro: error.message });

  logger.info(`[crm] ${req.usuario.nome} trocou a própria senha`);
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────
// Funil
// ──────────────────────────────────────────────

router.get('/api/funil', rota(async (req, res) => {
  const { leads, total } = await funil.listarFunil({
    etapas: req.query.etapas ? String(req.query.etapas).split(',').filter(Boolean) : null,
    dono: req.query.dono || null,
    origem: req.query.origem || null,
    busca: req.query.busca || null,
    desde: req.query.desde || null,
    ate: req.query.ate || null,
    ordenar: req.query.ordenar || 'last_activity_at',
    direcao: req.query.direcao || 'desc',
    limite: parseInt(req.query.limite || '200', 10),
    offset: parseInt(req.query.offset || '0', 10),
    incluirFechados: req.query.fechados === 'true',
  });

  res.json({ leads, total, etapas: funil.ETAPAS, rotulos: funil.ETAPAS_ROTULO });
}));

router.get('/api/funil/metricas', rota(async (req, res) => {
  res.json(await funil.metricasFunil({
    desde: req.query.desde || null,
    diasParado: parseInt(req.query.diasParado || '2', 10),
  }));
}));

/**
 * Pendências de atendimento — quem está esperando gente.
 *
 * Fica separado das métricas do funil de propósito: as métricas são
 * fotografia do pipeline e mudam devagar; isto aqui é alarme, o painel
 * repete a chamada a cada minuto e precisa que ela seja barata.
 */
router.get('/api/atendimento/pendencias', rota(async (req, res) => {
  const limite = Math.min(Math.max(parseInt(req.query.limite || '12', 10) || 12, 1), 50);
  res.json(await atendimento.pendencias({ limite }));
}));

router.get('/api/leads/:id', rota(async (req, res) => {
  const ficha = await funil.fichaDoLead(parseInt(req.params.id, 10));
  if (!ficha) return res.status(404).json({ erro: 'Lead não encontrado' });
  res.json(ficha);
}));

router.post('/api/leads', rota(async (req, res) => {
  const lead = await funil.criarLeadManual(req.body || {}, req.usuario);
  res.status(201).json(lead);
}));

/** Edição dos campos da ficha. Etapa NÃO se muda por aqui — ver /etapa. */
router.patch('/api/leads/:id', rota(async (req, res) => {
  const permitidos = {
    full_name: req.body.nomeCompleto,
    birth_date: req.body.dataNascimento,
    email: req.body.email,
    phone: req.body.telefone ? normalizePhone(req.body.telefone) : undefined,
    interest: req.body.interesse,
    evo_interests: req.body.interesses,
    notes: req.body.observacoes,
    owner_user_id: req.body.donoId,
    next_action_at: req.body.proximaAcaoEm,
    next_action_note: req.body.proximaAcaoNota,
  };
  const update = Object.fromEntries(
    Object.entries(permitidos).filter(([, v]) => v !== undefined)
  );

  if (!Object.keys(update).length) {
    return res.status(400).json({ erro: 'Nada para atualizar.' });
  }

  const { data, error } = await supabase
    .from('crm_leads')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });

  await funil.registrarEvento(data.id, {
    type: 'edicao',
    actor: `user:${req.usuario.id}`,
    actorUserId: req.usuario.id,
    summary: `${req.usuario.nome} editou: ${Object.keys(update).join(', ')}`,
    payload: update,
  });

  res.json(data);
}));

/** Mudança manual de etapa — a única que pode retroceder ou reabrir. */
router.post('/api/leads/:id/etapa', rota(async (req, res) => {
  const { etapa, motivo, motivoPerda } = req.body || {};
  if (!funil.ETAPAS.includes(etapa)) {
    return res.status(400).json({ erro: `Etapa inválida. Use uma de: ${funil.ETAPAS.join(', ')}` });
  }

  const campos = {};
  if (etapa === 'perdido') campos.lost_reason = motivoPerda || motivo || null;
  if (etapa === 'experimental_realizada') campos.experimental_status = 'realizada';

  const lead = await funil.mudarEtapa(parseInt(req.params.id, 10), etapa, {
    actor: `user:${req.usuario.id}`,
    actorUserId: req.usuario.id,
    motivo: motivo || `${req.usuario.nome} moveu para ${funil.ETAPAS_ROTULO[etapa]}`,
    campos,
  });

  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
  res.json(lead);
}));

/** "Este lead é meu" — assume a fila e vira dono. */
router.post('/api/leads/:id/assumir', rota(async (req, res) => {
  const lead = await funil.mudarEtapa(parseInt(req.params.id, 10), 'com_consultor', {
    actor: `user:${req.usuario.id}`,
    actorUserId: req.usuario.id,
    somenteAvanco: true,
    motivo: `${req.usuario.nome} assumiu o atendimento`,
    campos: { owner_user_id: req.usuario.id },
  });
  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
  res.json(lead);
}));

// ──────────────────────────────────────────────
// Ações que escrevem no EVO
//
// Todas devolvem o erro do EVO em texto para o painel mostrar. Escrita em
// produção que falha em silêncio é pior do que escrita que não acontece.
// ──────────────────────────────────────────────

async function carregarLead(id) {
  const { data } = await supabase.from('crm_leads').select('*').eq('id', id).maybeSingle();
  return data || null;
}

router.post('/api/leads/:id/evo', rota(async (req, res) => {
  const lead = await carregarLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });

  try {
    const r = await evoSync.cadastrarProspect(lead, { usuario: req.usuario, dados: req.body || {} });
    res.json(r);
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
}));

router.post('/api/leads/:id/experimental', rota(async (req, res) => {
  const lead = await carregarLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });

  try {
    res.json(await evoSync.agendarExperimental(lead, req.body || {}, { usuario: req.usuario }));
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
}));

router.post('/api/leads/:id/venda', rota(async (req, res) => {
  const lead = await carregarLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });

  try {
    res.json(await evoSync.registrarVenda(lead, req.body || {}, { usuario: req.usuario }));
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
}));

router.post('/api/leads/:id/followup', rota(async (req, res) => {
  const lead = await carregarLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });

  try {
    res.json(await evoSync.lancarFollowUp(lead, req.body?.mensagem, {
      usuario: req.usuario,
      proximaAcao: req.body?.proximaAcao || null,
    }));
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
}));

/**
 * Aciona à mão a régua de silêncio.
 *
 * ## Para que serve, já que o worker varre sozinho
 *
 * A varredura automática enxerga `FOLLOWUP_SILENCIO_JANELA_DIAS` para trás
 * (padrão: 7). Quem parou de responder há mais tempo que isso está fora do
 * alcance dela — de propósito, para o primeiro ciclo depois do deploy não
 * acordar lead de meses atrás. Este endpoint é como o consultor alcança
 * esse acumulado, decidindo ele até onde voltar.
 *
 * O critério de dias continua sendo um PISO (`>= dias`), não uma igualdade:
 * um lead parado há 5 dias que nunca foi cutucado entra normalmente. Por
 * isso não existe rotina separada de recuperação — é a mesma função, com a
 * janela aberta.
 *
 * ## Simula por padrão
 *
 * Sem `simular: false` explícito, NADA é gravado: a resposta lista quem
 * entraria, com quantos dias de silêncio cada um e por qual rodada. É uma
 * ação em lote sobre clientes reais, e a ordem certa é ler a lista antes.
 *
 * Body (tudo opcional):
 *   dias        piso de dias em silêncio      (padrão: config)
 *   janelaDias  quão para trás olhar          (padrão: config; teto de 90)
 *   lote        máximo de agendamentos        (padrão: config; teto de 50)
 *   simular     false para gravar de verdade  (padrão: true)
 */
router.post('/api/followups/varredura', rota(async (req, res) => {
  const corpo = req.body || {};

  const opcoes = {
    simular: corpo.simular !== false,
    ...(corpo.dias != null && { dias: Math.max(1, parseInt(corpo.dias, 10) || 2) }),
    ...(corpo.janelaDias != null && {
      janelaDias: Math.min(90, Math.max(1, parseInt(corpo.janelaDias, 10) || 7)),
    }),
    // Teto duro acima do configurado: a janela ampliada torna o conjunto
    // elegível muito maior, e 50 mensagens é o limite do que um consultor
    // consegue acompanhar num dia.
    ...(corpo.lote != null && { lote: Math.min(50, Math.max(1, parseInt(corpo.lote, 10) || 15)) }),
  };

  const resultado = await followup.varrerSilenciosos(opcoes);

  logger.info(
    `[crm] ${req.usuario.email} rodou a varredura de silêncio ` +
    `(${opcoes.simular ? 'simulação' : 'valendo'}): ` +
    `${resultado.leads.length} elegível(is), ${resultado.agendados} agendado(s)`
  );

  res.json({
    simulado: opcoes.simular,
    elegiveis: resultado.leads.length,
    agendados: resultado.agendados,
    examinados: resultado.examinados,
    leads: resultado.leads,
  });
}));

// ──────────────────────────────────────────────
// Conversas
// ──────────────────────────────────────────────

/** Lista de conversas, de todos os canais. */
router.get('/api/conversas', rota(async (req, res) => {
  const limite = Math.min(parseInt(req.query.limite || '100', 10), 300);

  let q = supabase
    .from('wa_conversations')
    .select(`
      id, status, channel, assigned_to, ai_enabled, started_at, last_message,
      contato:wa_contacts ( id, phone, name, is_prospect, tags )
    `, { count: 'exact' })
    .order('last_message', { ascending: false })
    .limit(limite);

  if (req.query.status) q = q.eq('status', req.query.status);
  if (req.query.canal) q = q.eq('channel', req.query.canal);
  // Por padrão o simulador fica de fora: é teste interno, não atendimento.
  else if (req.query.incluirTestes !== 'true') q = q.neq('channel', CANAL_SIMULADOR);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ erro: error.message });

  res.json({ conversas: data || [], total: count ?? 0 });
}));

/**
 * GET /crm/api/conversas/:id/mensagens
 *
 * O endpoint que faltava. Até aqui só existia busca de histórico **por
 * telefone**, na API de integração dos apps irmãos — inútil para um painel
 * que lista conversas por id, e exposto com a chave errada.
 */
router.get('/api/conversas/:id/mensagens', rota(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const limite = Math.min(parseInt(req.query.limite || '300', 10), 1000);

  const { data: conversa } = await supabase
    .from('wa_conversations')
    .select(`
      id, status, channel, assigned_to, ai_enabled, started_at, last_message,
      contato:wa_contacts ( id, phone, name, is_prospect, tags, evo_member_id )
    `)
    .eq('id', id)
    .maybeSingle();

  if (!conversa) return res.status(404).json({ erro: 'Conversa não encontrada' });

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('id, direction, content, content_type, sent_by, status, media_url, metadata, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(limite);

  // Os handoffs vêm da própria tabela, não do metadata das mensagens.
  //
  // É o que faz o briefing aparecer também nas conversas anteriores a esta
  // correção — a marca na mensagem só existe daqui para a frente, mas o
  // `wa_human_handoffs` sempre teve o texto. E é a fonte certa de qualquer
  // forma: ali está o estado de resolvido, que a mensagem não carrega.
  const { data: handoffs } = await supabase
    .from('wa_human_handoffs')
    .select('id, reason, resolved, assigned_to, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  // O lead correspondente, para o painel abrir a ficha a partir da conversa.
  let lead = null;
  if (conversa.contato?.id) {
    const { data } = await supabase
      .from('crm_leads')
      .select('id, stage, full_name, owner_user_id')
      .eq('contact_id', conversa.contato.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    lead = data || null;
  }

  res.json({
    conversa,
    lead,
    handoffs: (handoffs || []).map(h => ({
      id: h.id,
      motivo: h.reason,
      resolvido: h.resolved,
      atribuido: h.assigned_to,
      em: h.created_at,
    })),
    mensagens: (mensagens || []).map(m => ({
      id: m.id,
      de: m.direction === 'inbound' ? 'cliente'
        : m.sent_by?.startsWith('human') ? 'consultor'
        : m.sent_by === 'bot' ? 'leia' : m.sent_by,
      autor: m.sent_by,
      texto: m.content,
      tipo: m.content_type,
      midia: m.media_url,
      handoff: m.metadata?.handoff || false,
      motivoHandoff: m.metadata?.motivo_handoff || null,
      status: m.status,
      em: m.created_at,
    })),
  });
}));

/**
 * Responder pelo painel.
 *
 * Envia pelo WhatsApp e pausa a Leia na mesma ação. O handoff registrado
 * em 20/08/2026 deixou à vista que consultor e bot podem falar ao mesmo
 * tempo quando a conversa ainda está `active`; responder pelo painel é
 * declaração explícita de que o humano assumiu, então aqui a decisão é
 * tomada: humano falou, bot cala.
 */
/**
 * Primeiro nome, para assinar a mensagem.
 *
 * Só o primeiro: "*Shirlei:*" é como o aparelho já assina, e é como se
 * escreve no WhatsApp. Nome completo numa assinatura soa a formulário.
 */
function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || 'Atendimento';
}

/**
 * Quebra de linha da assinatura.
 *
 * Constante em vez de escape dentro do template literal: este arquivo é
 * CRLF, e um template de várias linhas levaria o retorno de carro junto
 * para dentro da mensagem enviada ao cliente.
 */
const QUEBRA_ASSINATURA = String.fromCharCode(10);

router.post('/api/conversas/:id/responder', rota(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const texto = String(req.body?.mensagem || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Mensagem vazia.' });

  const { data: conversa } = await supabase
    .from('wa_conversations')
    .select('id, channel, contact_id, contato:wa_contacts ( id, phone, name )')
    .eq('id', id)
    .maybeSingle();

  if (!conversa) return res.status(404).json({ erro: 'Conversa não encontrada' });
  if (conversa.channel === CANAL_SIMULADOR) {
    return res.status(400).json({ erro: 'Esta é uma conversa do simulador — use a aba Simulador.' });
  }

  // Assinatura do consultor, no mesmo formato que o aparelho já usa.
  //
  // Sem isto o cliente recebia do painel uma mensagem sem dono, na mesma
  // conversa em que as do celular vinham assinadas — e sem saber se estava
  // falando com uma pessoa ou com a Leia. Numa conversa que passa por bot,
  // consultor no painel e consultor no celular, saber quem está do outro
  // lado não é detalhe.
  //
  // O texto assinado é o que se envia E o que se grava: o histórico tem de
  // mostrar exatamente o que a pessoa leu. É também o que mantém a
  // checagem de eco por conteúdo funcionando em `registrarMensagemDeSaida`.
  const enviado = config.crm.assinarResposta
    ? `*${primeiroNome(req.usuario.nome)}:*` + QUEBRA_ASSINATURA + texto
    : texto;

  let evolutionMsgId = null;
  try {
    const r = await sendText(conversa.contato.phone, enviado);
    evolutionMsgId = r?.key?.id || null;
  } catch (err) {
    logger.error('[crm] Falha ao enviar pelo WhatsApp:', err.message);
    return res.status(502).json({ erro: `WhatsApp não aceitou o envio: ${err.message}` });
  }

  await saveMessage({
    conversationId: id,
    contactId: conversa.contact_id,
    direction: 'outbound',
    content: enviado,
    sentBy: `human:${req.usuario.email}`,
    evolutionMsgId,
    status: 'sent',
  });

  await supabase
    .from('wa_conversations')
    .update({
      status: 'human',
      ai_enabled: false,
      assigned_to: req.usuario.nome,
      last_message: new Date().toISOString(),
    })
    .eq('id', id);

  try {
    await funil.aoConsultorAssumir(conversa.contato, { usuario: req.usuario, via: 'painel' });
  } catch (err) {
    logger.error('[crm] Funil falhou ao registrar resposta do consultor:', err.message);
  }

  res.json({ ok: true, enviado });
}));

/** Devolve a conversa para a Leia. */
router.post('/api/conversas/:id/reativar', rota(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await reactivateBot(id);

  await supabase
    .from('wa_human_handoffs')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('conversation_id', id)
    .eq('resolved', false);

  logger.info(`[crm] ${req.usuario.nome} devolveu a conversa ${id} para a Leia`);
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────
// Simulador — conversar com a Leia sem WhatsApp
//
// Herdeiro da /teste, com uma diferença: o contato de teste é o do
// consultor logado, não uma sessão anônima. Assim dá para saber quem
// testou o quê sem depender de alguém preencher um campo de nome.
// ──────────────────────────────────────────────

async function contatoDoSimulador(usuario) {
  const phone = `teste-crm-${usuario.id}`;

  const { data: existente } = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (existente) return existente;

  const { data, error } = await supabase
    .from('wa_contacts')
    .insert({
      phone,
      name: usuario.nome,
      is_prospect: true,
      tags: ['teste-web', 'simulador-crm'],
      metadata: { origem: 'simulador-crm', usuario: usuario.email },
    })
    .select()
    .single();

  if (error) throw new Error(`não foi possível criar o contato do simulador: ${error.message}`);
  return data;
}

async function conversaDoSimulador(contactId) {
  const { data: existente } = await supabase
    .from('wa_conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('channel', CANAL_SIMULADOR)
    .in('status', ['active', 'human'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existente) return existente;

  const { data, error } = await supabase
    .from('wa_conversations')
    .insert({
      contact_id: contactId,
      status: 'active',
      channel: CANAL_SIMULADOR,
      ai_enabled: true,
      context: { origem: 'simulador-crm' },
    })
    .select()
    .single();

  if (error) throw new Error(`não foi possível abrir a conversa do simulador: ${error.message}`);
  return data;
}

router.get('/api/simulador/sessao', rota(async (req, res) => {
  const contato = await contatoDoSimulador(req.usuario);
  const conversa = await conversaDoSimulador(contato.id);

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('direction, content, metadata, created_at')
    .eq('conversation_id', conversa.id)
    .order('created_at', { ascending: true })
    .limit(300);

  res.json({
    conversaId: conversa.id,
    mensagens: (mensagens || []).map(m => ({
      de: m.direction === 'inbound' ? 'voce' : 'leia',
      texto: m.content,
      handoff: m.metadata?.handoff || false,
      em: m.created_at,
    })),
  });
}));

const ultimaMsgPorUsuario = new Map();
const INTERVALO_MIN_MS = 1200;
const MAX_CHARS = 800;

router.post('/api/simulador/mensagem', rota(async (req, res) => {
  const mensagem = String(req.body?.mensagem || '').trim();
  if (!mensagem) return res.status(400).json({ erro: 'Mensagem vazia.' });
  if (mensagem.length > MAX_CHARS) {
    return res.status(400).json({ erro: `Mensagem muito longa (máximo ${MAX_CHARS} caracteres).` });
  }

  // Cada resposta gasta crédito de API — o teto continua valendo mesmo
  // com login, porque o custo é por mensagem, não por pessoa.
  const agora = Date.now();
  if (agora - (ultimaMsgPorUsuario.get(req.usuario.id) || 0) < INTERVALO_MIN_MS) {
    return res.status(429).json({ erro: 'Espere um instante entre as mensagens.' });
  }
  ultimaMsgPorUsuario.set(req.usuario.id, agora);

  const contato = await contatoDoSimulador(req.usuario);
  const conversa = await conversaDoSimulador(contato.id);

  const salva = await saveMessage({
    conversationId: conversa.id,
    contactId: contato.id,
    direction: 'inbound',
    content: mensagem,
    sentBy: 'simulador',
    metadata: { canal: CANAL_SIMULADOR, usuario: req.usuario.email },
  });

  const resposta = await aiAgent.processMessage({
    message: mensagem,
    conversationId: conversa.id,
    excludeMessageId: salva?.id,
    contactInfo: {
      id: contato.id,
      name: contato.name,
      phone: 'simulador (painel)',
      is_prospect: contato.is_prospect,
      tags: contato.tags,
    },
    origem: 'crm',
  });

  const houveHandoff = resposta.action === 'handoff';

  // Handoff no simulador é gravado mas NÃO desliga a IA — no WhatsApp o
  // bot pararia, e o teste morreria justamente no ponto que mais interessa
  // avaliar. O mesmo desenho da /teste, pelo mesmo motivo.
  if (houveHandoff) {
    await supabase.from('wa_human_handoffs').insert({
      conversation_id: conversa.id,
      contact_id: contato.id,
      reason: `[simulador] ${resposta.handoffReason || 'sem motivo informado'}`,
      resolved: true,
      resolved_at: new Date().toISOString(),
    });
  }

  await saveMessage({
    conversationId: conversa.id,
    contactId: contato.id,
    direction: 'outbound',
    content: resposta.text,
    sentBy: 'bot',
    metadata: {
      canal: CANAL_SIMULADOR,
      handoff: houveHandoff || undefined,
      motivo_handoff: resposta.handoffReason,
      tools: (resposta.toolResults || []).map(t => t.tool),
    },
  });

  res.json({
    resposta: resposta.text,
    handoff: houveHandoff,
    motivo: houveHandoff ? resposta.handoffReason : undefined,
    tools: (resposta.toolResults || []).map(t => t.tool),
  });
}));

router.post('/api/simulador/reiniciar', rota(async (req, res) => {
  const contato = await contatoDoSimulador(req.usuario);
  await supabase
    .from('wa_conversations')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('contact_id', contato.id)
    .eq('channel', CANAL_SIMULADOR)
    .in('status', ['active', 'human']);
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────
// Catálogo do EVO — alimenta os formulários do painel
// ──────────────────────────────────────────────

/**
 * Cache curto do catálogo.
 *
 * Planos, serviços e atividades mudam raramente e são pedidos a cada
 * abertura de formulário de venda. Sem cache, cada consultor que abre a
 * ficha de um lead dispara três chamadas ao EVO.
 */
const catalogo = new Map();
const CATALOGO_TTL_MS = 10 * 60 * 1000;

async function comCache(chave, buscar) {
  const guardado = catalogo.get(chave);
  if (guardado && Date.now() - guardado.em < CATALOGO_TTL_MS) return guardado.dados;

  const dados = await buscar();
  catalogo.set(chave, { dados, em: Date.now() });
  return dados;
}

router.get('/api/evo/planos', rota(async (req, res) => {
  try {
    res.json(await comCache('planos', () => evoClient.listarPlanos()));
  } catch (err) {
    res.status(502).json({ erro: `EVO não respondeu: ${err.message}` });
  }
}));

router.get('/api/evo/servicos', rota(async (req, res) => {
  try {
    res.json(await comCache('servicos', () => evoClient.listarServicos()));
  } catch (err) {
    res.status(502).json({ erro: `EVO não respondeu: ${err.message}` });
  }
}));

router.get('/api/evo/atividades', rota(async (req, res) => {
  try {
    res.json(await comCache('atividades', () => evoClient.listarAtividades()));
  } catch (err) {
    res.status(502).json({ erro: `EVO não respondeu: ${err.message}` });
  }
}));

router.get('/api/evo/interesses', rota(async (req, res) => {
  try {
    res.json(await comCache('interesses', () => evoClient.listarInteresses()));
  } catch (err) {
    res.status(502).json({ erro: `EVO não respondeu: ${err.message}` });
  }
}));

router.get('/api/evo/grade', rota(async (req, res) => {
  try {
    res.json(await evoClient.buscarGrade({
      date: req.query.data,
      idActivity: req.query.idAtividade,
    }));
  } catch (err) {
    res.status(502).json({ erro: `EVO não respondeu: ${err.message}` });
  }
}));

// ──────────────────────────────────────────────
// Ajustes — admin
// ──────────────────────────────────────────────

router.get('/api/whatsapp/status', exigirAdmin, rota(async (req, res) => {
  try {
    res.json(await getConnectionStatus());
  } catch (err) {
    // "instance does not exist" é resposta legítima antes do primeiro
    // pareamento — o painel precisa dela para oferecer "criar instância".
    res.json({ erro: err.message, instancia: config.evolution.instance });
  }
}));

router.post('/api/whatsapp/instancia', exigirAdmin, rota(async (req, res) => {
  try {
    res.json(await criarInstancia());
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
}));

/**
 * QR code para parear o número.
 *
 * Devolve o **base64** que vem no corpo da resposta da Evolution, não o
 * link montado com SERVER_URL. É o que permite manter a porta 8080
 * fechada no loopback: quem alcança a Evolution é o backend, e o
 * navegador do consultor só recebe a imagem já pronta.
 */
router.get('/api/whatsapp/qrcode', exigirAdmin, rota(async (req, res) => {
  try {
    const qr = await getQrCode();
    res.json({
      base64: qr?.base64 || qr?.qrcode?.base64 || null,
      code: qr?.code || qr?.qrcode?.code || null,
      pairingCode: qr?.pairingCode || null,
      bruto: qr,
    });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
}));

router.get('/api/evo/webhooks', exigirAdmin, rota(async (req, res) => {
  try {
    res.json(await evoClient.listarWebhooks());
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
}));

router.post('/api/evo/webhooks', exigirAdmin, rota(async (req, res) => {
  try {
    res.json(await evoSync.registrarWebhooks({ urlBase: req.body?.urlBase }));
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
}));

router.post('/api/evo/sincronizar', exigirAdmin, rota(async (req, res) => {
  res.json(await evoSync.sincronizarProspects({ dias: parseInt(req.body?.dias || '7', 10) }));
}));

// ──────────────────────────────────────────────
// Consultores — admin
// ──────────────────────────────────────────────

router.get('/api/usuarios', rota(async (req, res) => {
  const { data, error } = await supabase
    .from('crm_users')
    .select('id, name, email, role, active, last_login_at, created_at')
    .order('name');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data || []);
}));

router.post('/api/usuarios', exigirAdmin, rota(async (req, res) => {
  const { nome, email, senha, papel } = req.body || {};
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'nome, email e senha são obrigatórios.' });
  }
  if (String(senha).length < 8) {
    return res.status(400).json({ erro: 'A senha precisa de pelo menos 8 caracteres.' });
  }

  const { data, error } = await supabase
    .from('crm_users')
    .insert({
      name: nome,
      email: String(email).trim().toLowerCase(),
      password_hash: await hashSenha(senha),
      role: papel === 'admin' ? 'admin' : 'consultor',
    })
    .select('id, name, email, role, active')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ erro: 'Já existe consultor com este e-mail.' });
    return res.status(500).json({ erro: error.message });
  }

  logger.info(`[crm] ${req.usuario.nome} criou o consultor ${data.email}`);
  res.status(201).json(data);
}));

router.patch('/api/usuarios/:id', exigirAdmin, rota(async (req, res) => {
  const update = {};
  if (req.body.nome !== undefined) update.name = req.body.nome;
  if (req.body.ativo !== undefined) update.active = !!req.body.ativo;
  if (req.body.papel !== undefined) update.role = req.body.papel === 'admin' ? 'admin' : 'consultor';
  if (req.body.senha) {
    if (String(req.body.senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa de pelo menos 8 caracteres.' });
    }
    update.password_hash = await hashSenha(req.body.senha);
  }

  if (!Object.keys(update).length) return res.status(400).json({ erro: 'Nada para atualizar.' });

  const { data, error } = await supabase
    .from('crm_users')
    .update(update)
    .eq('id', req.params.id)
    .select('id, name, email, role, active')
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
}));

export default router;
