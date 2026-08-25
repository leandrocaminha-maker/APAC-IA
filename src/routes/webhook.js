/**
 * src/routes/webhook.js
 * Recebe webhooks da Evolution API (mensagens recebidas, status, etc.).
 */
import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage, handoffToHuman } from '../services/contacts.js';
import { aiAgent } from '../services/ai-agent.js';
import { sendText, normalizePhone } from '../services/evolution.js';
import { funil } from '../services/funil.js';
import { evoSync } from '../services/evo-sync.js';
import { campanhas } from '../services/campanhas.js';

const router = Router();

/**
 * Move o funil sem nunca derrubar o atendimento.
 *
 * O funil é observação, não caminho crítico: se o Supabase engasgar na
 * hora de gravar a etapa, a mensagem do cliente ainda tem que ser
 * respondida. Por isso toda chamada de funil no fluxo do WhatsApp passa
 * por aqui em vez de ir direta.
 */
async function moverFunil(fn) {
  try {
    await fn();
  } catch (err) {
    logger.error('[webhook] Funil falhou (atendimento seguiu normalmente):', err.message);
  }
}

/**
 * POST /webhook/evolution
 * Endpoint chamado pela Evolution API quando eventos ocorrem.
 */
router.post('/evolution', async (req, res) => {
  try {
    const event = req.body;

    // Verifica webhook secret.
    // Se WEBHOOK_SECRET está configurado, a requisição é obrigada a
    // apresentá-lo — omitir o header não pode passar direto.
    if (config.webhookSecret) {
      const headerSecret = req.headers['x-webhook-secret'] || req.query.secret;
      if (headerSecret !== config.webhookSecret) {
        logger.warn('[webhook] Requisição rejeitada: secret ausente ou inválido');
        return res.status(401).json({ error: 'Webhook secret inválido' });
      }
    }

    // Determina o tipo de evento
    const eventType = event.event || event.type || '';

    logger.debug(`[webhook] Evento recebido: ${eventType}`);

    switch (eventType) {
      case 'messages.upsert':
      case 'MESSAGES_UPSERT':
        await handleIncomingMessage(event);
        break;

      case 'messages.update':
      case 'MESSAGES_UPDATE':
        await handleMessageStatus(event);
        break;

      case 'connection.update':
      case 'CONNECTION_UPDATE':
        handleConnectionUpdate(event);
        break;

      default:
        logger.debug(`[webhook] Evento ignorado: ${eventType}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[webhook] Erro ao processar webhook:', err);
    // Retorna 200 mesmo com erro para não gerar retry infinito
    res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * POST /webhook/evo
 * Webhooks do EVO / W12 — venda, conversão, contrato, matrícula em aula.
 *
 * O EVO manda um envelope enxuto e síncrono:
 *   { IdW12, IdBranch, IdRecord, EventType, ApiCallback }
 *
 * Por isso a resposta é imediata e o processamento fica para depois: o
 * dado de verdade está atrás do `ApiCallback`, que é outra chamada HTTP à
 * API do EVO. Fazer isso dentro da requisição faria o EVO esperar por nós
 * e reentregar por timeout.
 *
 * ⚠️ Autenticação é fail-closed. Sem EVO_WEBHOOK_SECRET configurado o
 * endpoint responde 503 e não aceita nada — ele escreve no funil, e um
 * webhook aberto deixa qualquer um marcar lead como ganho.
 */
router.post('/evo', async (req, res) => {
  if (!config.crm.evoWebhookSecret) {
    logger.error('[webhook/evo] EVO_WEBHOOK_SECRET não configurado — endpoint bloqueado');
    return res.status(503).json({ erro: 'Webhook do EVO não configurado' });
  }

  const enviado = req.headers['x-evo-secret'] || req.query.secret;
  if (enviado !== config.crm.evoWebhookSecret) {
    logger.warn('[webhook/evo] Requisição rejeitada: secret ausente ou inválido');
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  // O EVO pode mandar um evento ou um lote.
  //
  // São DOIS sistemas de webhook, com envelopes diferentes, chegando na
  // mesma porta:
  //
  //   API (/api/v1/webhook)  → `EventType` maiúsculo, ids + ApiCallback
  //   Automação do CRM       → `eventType` minúsculo, payload completo
  //
  // Ler só o maiúsculo era o que fazia a automação aparecer no log como
  // "1 evento(s): ?".
  const envelopes = Array.isArray(req.body) ? req.body : [req.body];
  const tipoDe = (e) => e?.EventType || e?.eventType || '?';
  logger.info(`[webhook/evo] ${envelopes.length} evento(s): ${envelopes.map(tipoDe).join(', ')}`);

  res.status(200).json({ recebido: envelopes.length });

  // Depois da resposta: guardar e processar sem segurar o EVO.
  for (const envelope of envelopes) {
    try {
      const evento = await evoSync.guardarEventoWebhook(envelope);
      if (!evento) continue; // duplicado

      // Segmentação do CRM: a coorte da campanha, uma pessoa por POST.
      // Não passa pelo `processarEventoWebhook` — aquele switch é do
      // webhook da API, trabalha com ApiCallback e não tem o que fazer
      // aqui, porque este payload já vem completo.
      if (String(tipoDe(envelope)).startsWith('crm.segmentation')) {
        const r = await campanhas.absorverSegmentacao(envelope);
        if (r.ok && r.alvoId) {
          logger.info(`[webhook/evo] Alvo criado na campanha "${r.campanha}"`);
        } else if (!r.ok) {
          logger.warn(`[webhook/evo] Segmentação ignorada: ${r.motivo}`);
        }
        continue;
      }

      await evoSync.processarEventoWebhook(evento);
    } catch (err) {
      logger.error('[webhook/evo] Falha ao processar evento:', err.message);
    }
  }
});

/**
 * Processa mensagem recebida do WhatsApp.
 */
async function handleIncomingMessage(event) {
  const data = event.data || event;

  // Extrai dados da mensagem
  const messageData = data.message || data;
  const key = data.key || messageData.key || {};

  // Ignora mensagens de grupo (por enquanto)
  if (key.remoteJid?.includes('@g.us')) {
    logger.debug('[webhook] Ignorando mensagem de grupo');
    return;
  }

  // Extrai número do remetente
  const remoteJid = key.remoteJid || '';
  const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

  if (!phone) {
    logger.warn('[webhook] Mensagem sem remetente identificável');
    return;
  }

  // Extrai conteúdo da mensagem
  const msg = messageData.message || messageData;
  let content = '';
  let contentType = 'text';
  let mediaUrl = null;

  if (msg.conversation) {
    content = msg.conversation;
  } else if (msg.extendedTextMessage?.text) {
    content = msg.extendedTextMessage.text;
  } else if (msg.imageMessage) {
    content = msg.imageMessage.caption || '[imagem]';
    contentType = 'image';
  } else if (msg.documentMessage) {
    content = msg.documentMessage.fileName || '[documento]';
    contentType = 'document';
  } else if (msg.audioMessage) {
    content = '[áudio]';
    contentType = 'audio';
  } else if (msg.videoMessage) {
    content = msg.videoMessage.caption || '[vídeo]';
    contentType = 'video';
  } else if (msg.buttonsResponseMessage) {
    content = msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId || '';
  } else if (msg.listResponseMessage) {
    content = msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId || '';
  } else {
    // Tipo de mensagem não suportado
    content = '[mensagem não suportada]';
    contentType = 'unknown';
  }

  if (!content) {
    logger.debug('[webhook] Mensagem sem conteúdo extraível');
    return;
  }

  // Extrai nome do contato (push name do WhatsApp)
  const pushName = data.pushName || messageData.pushName || null;

  // Mensagem saindo do NOSSO número: ou é o eco do que a Leia acabou de mandar,
  // ou é o consultor humano digitando direto no WhatsApp. O segundo caso precisa
  // ser gravado; o primeiro já está no banco.
  if (key.fromMe) {
    await registrarMensagemDeSaida({ phone, content, contentType, evolutionMsgId: key.id });
    return;
  }

  logger.info(`[webhook] 📩 ${phone} (${pushName || '?'}): ${content.slice(0, 100)}`);

  // Busca ou cria contato e conversa
  const contact = await getOrCreateContact(phone, pushName);
  const conversation = await getOrCreateConversation(contact.id);

  // Salva mensagem recebida
  const savedMessage = await saveMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    direction: 'inbound',
    content,
    contentType,
    sentBy: 'client',
    evolutionMsgId: key.id || null,
    metadata: { pushName, remoteJid },
    status: 'delivered',
  });

  // "SAIR" encerra tudo, e encerra ANTES de qualquer outra coisa.
  //
  // Vem antes do funil, do agente e até da checagem de modo humano: quem
  // pediu para parar de receber mensagem não pode ter o pedido processado
  // como se fosse conversa. A supressão também apaga o que já estava
  // agendado na fila — receber mais uma mensagem depois de pedir para sair
  // é o que transforma um pedido em denúncia, e denúncia em bloqueio do
  // número.
  if (campanhas.ehPedidoDeSaida(content)) {
    const { canceladas } = await campanhas.suprimir(phone, {
      motivo: 'pediu_para_sair',
      origem: 'whatsapp',
      detalhe: content,
    });

    logger.info(`[webhook] ${phone} pediu para sair (${canceladas} agendada(s) cancelada(s))`);

    await sendAndSave(
      phone,
      'Prontinho, não te mando mais mensagem por aqui 👍\n\n' +
      'Se um dia quiser falar com a gente, é só chamar neste mesmo número.',
      conversation.id,
      contact.id,
      { opt_out: true },
    );
    return;
  }

  // Respondeu a uma campanha: ela para para essa pessoa, e a conversa segue
  // pelo caminho normal do agente. Falar campanha por cima de conversa em
  // andamento seria falar duas vezes ao mesmo tempo.
  await campanhas.registrarResposta(phone).catch(err =>
    logger.warn('[webhook] Não consegui encerrar o alvo de campanha:', err.message));

  // Porta de consentimento da campanha.
  //
  // A abertura só pede licença ("temos uma condição especial, tem interesse
  // de saber?"). Interpretar esse "sim" com o prompt de vendas inteiro
  // custaria ~48.000 tokens para ler três letras — por isso o sim e o não
  // são resolvidos aqui, e só quem vai além disso chega ao agente completo.
  //
  // Falha para o lado seguro: qualquer coisa que não seja um sim ou um não
  // curto e claro cai no agente, que sabe lidar com o resto.
  if (await tratarConsentimentoDeCampanha({ phone, contact, conversation, content })) return;

  // O lead entra no funil na primeira mensagem, e volta para "em conversa"
  // a cada resposta — sem retroceder quem já avançou.
  await moverFunil(() => funil.aoReceberMensagem(contact));

  // Quem respondeu não está em silêncio: as sondagens pendentes perdem o
  // motivo de existir. O lembrete da aula e a conversa pós-aula NÃO são
  // canceladas — elas dependem da aula, não do silêncio.
  await moverFunil(async () => {
    const lead = await funil.leadAbertoPorContato(contact.id);
    if (lead) {
      const { followup } = await import('../services/followup.js');
      await followup.cancelar(lead.id, ['sondagem_1', 'sondagem_2'], 'o cliente respondeu');
    }
  });

  // Se conversa está em modo humano, não processa com IA
  if (conversation.status === 'human') {
    logger.info(`[webhook] Conversa em modo humano — mensagem registrada sem resposta IA`);
    return;
  }

  // Se a mensagem é de tipo não-textual, responde genericamente
  if (contentType !== 'text' && contentType !== 'unknown') {
    if (contentType === 'audio') {
      await sendAndSave(
        phone,
        'Desculpe, ainda não consigo ouvir áudios 🙁 Poderia me enviar por texto?',
        conversation.id,
        contact.id
      );
      return;
    }
    // Imagens, documentos, vídeos → registra mas não processa com IA
    return;
  }

  // Não responde agora: enfileira e espera os próximos balões. Ver
  // `agendarResposta`.
  agendarResposta({ phone, contact, conversation, savedMessage, content });
}

// ──────────────────────────────────────────────
// Agrupamento de mensagens picotadas
//
// No WhatsApp a pergunta chega em pedaços: "oi", "queria saber de natação",
// "é pro meu filho". Até 24/08/2026 cada pedaço disparava um turno completo
// do agente — três chamadas à API, cada uma reenviando o prefixo inteiro, e
// a primeira resposta saindo antes de a pessoa terminar de perguntar. O
// agente respondia "natação para quem?" enquanto a resposta já estava
// chegando.
//
// Agora cada mensagem reinicia um cronômetro curto e só o silêncio dispara a
// resposta. As mensagens acumuladas viram um único turno, separadas por
// quebra de linha.
//
// **O teto existe para quem não para de digitar.** Sem ele, um cliente
// ansioso mandando um balão a cada 10 segundos adiaria a resposta para
// sempre. Passado `debounceTetoSegundos` desde o PRIMEIRO balão, responde-se
// com o que houver.
//
// **O que continua imediato:** gravar a mensagem, mover o funil e cancelar
// as sondagens pendentes. Só a resposta espera — o resto do sistema enxerga
// a mensagem no instante em que ela chega.
//
// **Limite conhecido:** os buffers vivem em memória. Um restart do container
// com mensagens pendentes perde a resposta daquele turno (a mensagem do
// cliente já está gravada). Aceito enquanto for um processo só; virou fila
// no banco no dia em que houver mais de uma réplica.
// ──────────────────────────────────────────────

const buffers = new Map(); // conversationId -> { timer, mensagens, ... }

// Conversas com um turno do agente em voo. Ver `responderBuffer`.
const emAtendimento = new Set();

const DEBOUNCE_MS = Math.max(0, config.agente.debounceSegundos) * 1000;
const DEBOUNCE_TETO_MS = Math.max(0, config.agente.debounceTetoSegundos) * 1000;

// De quanto em quanto tempo reconferir se o turno em voo já terminou.
const REARME_MS = 2_000;

/**
 * Acumula a mensagem e (re)arma o cronômetro da resposta.
 */
function agendarResposta({ phone, contact, conversation, savedMessage, content }) {
  const chave = conversation.id;
  const agora = Date.now();

  let buf = buffers.get(chave);
  if (!buf) {
    buf = { mensagens: [], primeiroEm: agora, timer: null };
    buffers.set(chave, buf);
  }

  // Sempre os dados mais recentes: o `pushName` pode ter chegado só agora.
  buf.phone = phone;
  buf.contact = contact;
  buf.conversation = conversation;
  buf.mensagens.push({ id: savedMessage?.id ?? null, content });

  if (buf.timer) clearTimeout(buf.timer);

  const restanteDoTeto = DEBOUNCE_TETO_MS - (agora - buf.primeiroEm);
  const espera = Math.max(0, Math.min(DEBOUNCE_MS, restanteDoTeto));

  if (buf.mensagens.length > 1) {
    logger.debug(`[webhook] Agrupando (${buf.mensagens.length} msgs), respondendo em ${espera}ms`);
  }

  buf.timer = setTimeout(() => {
    responderBuffer(chave).catch(err =>
      logger.error('[webhook] Falha ao responder o buffer:', err));
  }, espera);

  // Não segura o processo no shutdown.
  buf.timer.unref?.();
}

/**
 * Dispara o turno do agente com tudo o que se acumulou.
 */
async function responderBuffer(chave) {
  const buf = buffers.get(chave);
  if (!buf) return;

  // Já existe um turno em voo para esta conversa.
  //
  // Acontece quando a pessoa escreve de novo enquanto o agente ainda está
  // pensando. Deixar os dois correrem juntos custaria duas chamadas cheias
  // e produziria duas respostas — a segunda sem enxergar a primeira, porque
  // a resposta do agente só é gravada no fim. Melhor esperar: quando o
  // turno atual terminar, a mensagem nova entra num turno próprio, já com a
  // resposta anterior no histórico.
  if (emAtendimento.has(chave)) {
    buf.timer = setTimeout(() => {
      responderBuffer(chave).catch(err =>
        logger.error('[webhook] Falha ao responder o buffer:', err));
    }, REARME_MS);
    buf.timer.unref?.();
    return;
  }

  buffers.delete(chave);
  emAtendimento.add(chave);

  try {
    const { phone, contact, conversation, mensagens } = buf;

    // Um consultor pode ter assumido a conversa durante a espera. O status
    // lido lá em cima está velho — vale o de agora.
    const { data: atual } = await supabase
      .from('wa_conversations')
      .select('status')
      .eq('id', conversation.id)
      .single();

    if (atual?.status === 'human') {
      logger.info('[webhook] Conversa passou a modo humano durante o agrupamento — sem resposta IA');
      return;
    }

    // Um turno só, na ordem em que a pessoa escreveu.
    const content = mensagens.map(m => m.content).join('\n');
    const savedIds = mensagens.map(m => m.id).filter(Boolean);

    await responderTurno({ phone, contact, conversation, content, savedIds });
  } finally {
    emAtendimento.delete(chave);
  }
}

/**
 * Um turno do agente: chama a IA, trata handoff e envia a resposta.
 */
async function responderTurno({ phone, contact, conversation, content, savedIds }) {
  try {
    const aiResponse = await aiAgent.processMessage({
      message: content,
      conversationId: conversation.id,
      excludeMessageId: savedIds,
      contactInfo: {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        is_prospect: contact.is_prospect,
        tags: contact.tags,
      },
      origem: 'webhook',
    });

    // Se IA solicitou handoff
    if (aiResponse.action === 'handoff') {
      await handoffToHuman(
        conversation.id,
        contact.id,
        aiResponse.handoffReason
      );
      // O handoff deixa de ser uma linha numa fila que ninguém olha: vira
      // etapa do funil, visível na tabela do painel com o tempo parado.
      await moverFunil(() => funil.aoAbrirHandoff(contact, aiResponse.handoffReason));
    }

    // Envia resposta. Quando houve handoff, a mensagem leva junto a marca e
    // o motivo — é o que faz o briefing aparecer no ponto certo da conversa,
    // no painel e na transcrição.
    if (aiResponse.text) {
      await sendAndSave(
        phone,
        aiResponse.text,
        conversation.id,
        contact.id,
        aiResponse.action === 'handoff'
          ? { handoff: true, motivo_handoff: aiResponse.handoffReason }
          : {}
      );
    }
  } catch (err) {
    logger.error(`[webhook] Erro no processamento IA para ${phone}:`, err);

    // Falha da IA vira HANDOFF, não só uma frase de espera.
    //
    // Antes o cliente lia "já vou te atender" e a conversa morria ali:
    // nenhum handoff era registrado, o funil não andava e ninguém ficava
    // sabendo. A promessa era pior do que o silêncio.
    //
    // Isso deixou de ser hipótese em 23/08/2026, quando o saldo da API da
    // Anthropic acabou: toda mensagem recebida caía aqui, e cada pessoa
    // recebia a promessa de um atendimento que não estava a caminho.
    const motivo = `Falha técnica no atendimento automático (${err?.message?.slice(0, 120) || 'erro desconhecido'}). ` +
      'O cliente escreveu e a IA não respondeu — retomar a conversa do ponto em que parou.';

    try {
      await handoffToHuman(conversation.id, contact.id, motivo);
      await moverFunil(() => funil.aoAbrirHandoff(contact, motivo));
    } catch (e2) {
      logger.error('[webhook] Falha ao registrar o handoff de emergência:', e2.message);
    }

    await sendAndSave(
      phone,
      'Opa, tive um probleminha técnico aqui 😅 Já passei sua mensagem para um consultor — ' +
      'ele te responde por aqui mesmo. Desculpa a demora!',
      conversation.id,
      contact.id
    );
  }
}

/**
 * Resolve a resposta à abertura da campanha, sem acordar o agente completo.
 *
 * A abertura pergunta se a pessoa quer conhecer a condição. Só isso. Ler
 * "sim" com o prompt de vendas inteiro custaria ~48.000 tokens de prefixo
 * para interpretar três letras — e a campanha é justamente onde o volume
 * multiplica esse custo.
 *
 * Três saídas:
 *   sim   → manda a oferta (com o link de checkout da pessoa) e encerra o turno
 *   não   → agradece, encerra, marca no funil. SEM handoff: 47 recusas
 *           virariam 47 pendências numa fila que já tem gente esperando.
 *   outro → devolve false e o agente completo assume, como sempre
 *
 * @returns {Promise<boolean>} true se o turno já foi resolvido aqui.
 */
async function tratarConsentimentoDeCampanha({ phone, contact, conversation, content }) {
  let alvo;
  try {
    alvo = await campanhas.alvoAguardandoConsentimento(phone);
  } catch (err) {
    logger.warn('[webhook] Não consegui ler o alvo de campanha:', err.message);
    return false;
  }
  if (!alvo) return false;

  const decisao = campanhas.lerConsentimento(content);
  logger.info(`[webhook] Campanha "${alvo.campanha?.slug}": ${phone} respondeu "${decisao}"`);

  if (decisao === 'outro') {
    // Foi além do sim/não. A partir daqui é conversa, e conversa é do
    // agente completo — inclusive as perguntas sobre a própria oferta.
    await campanhas.marcarEtapaConversa(alvo.id, 'conversando');
    return false;
  }

  if (decisao === 'nao') {
    await campanhas.marcarEtapaConversa(alvo.id, 'recusou');
    await sendAndSave(
      phone,
      'Sem problema, obrigada por responder 🙂\n\n' +
      'Qualquer dia que quiser saber como está a academia, é só me chamar por aqui.',
      conversation.id,
      contact.id,
      { campanha: alvo.campanha?.slug, decisao: 'recusou' },
    );
    await moverFunil(() => funil.aoReceberMensagem(contact));
    return true;
  }

  // Disse que sim: a oferta vai agora, no mesmo turno.
  try {
    const { text } = await aiAgent.gerarMensagemCampanha({
      alvo,
      oferta: alvo.campanha?.oferta,
      roteiro: alvo.campanha?.roteiro,
      etapa: 'oferta',
      // O que a academia decidiu que a pessoa precisa saber, e que o
      // gerador confere depois de escrever. Ver `pontosFaltando`.
      pontosObrigatorios: alvo.campanha?.metadata?.pontos_obrigatorios ?? [],
      conversationId: conversation.id,
    });

    if (!text) throw new Error('o gerador não produziu texto');

    await campanhas.marcarEtapaConversa(alvo.id, 'aceitou');
    await sendAndSave(phone, text, conversation.id, contact.id, {
      campanha: alvo.campanha?.slug, decisao: 'aceitou',
    });
    return true;
  } catch (err) {
    // Se a oferta não pôde ser gerada, NÃO se responde qualquer coisa: a
    // pessoa acabou de dizer que quer ouvir. Deixa o agente completo
    // assumir, que é quem sabe conduzir sem o texto pronto.
    logger.error('[webhook] Falha ao gerar a oferta da campanha:', err.message);
    await campanhas.marcarEtapaConversa(alvo.id, 'conversando');
    return false;
  }
}

/**
 * Registra uma mensagem que saiu do NOSSO número.
 *
 * A Evolution devolve pelo webhook tudo o que sai da instância, inclusive o que
 * a própria Leia acabou de enviar. O caso que interessa aqui é o outro: o
 * **consultor humano respondendo direto do WhatsApp**, no aparelho. Até
 * 20/08/2026 essas mensagens eram descartadas, e o histórico ficava com o
 * cliente falando e ninguém respondendo — o que falseava a análise das conversas
 * e impediria o agente de retomar uma conversa que passou por um humano sem
 * repetir o que já foi combinado.
 *
 * Não roda a IA: mensagem nossa não pede resposta nossa.
 *
 * **Como distinguir do eco.** Duas checagens, porque uma só não basta:
 *
 * 1. `evolution_msg_id` — o envio da Leia grava esse id na hora. Se já existe,
 *    este webhook é o eco do nosso próprio disparo.
 * 2. Mesmo conteúdo, mesmo contato, nos últimos 30 segundos. Cobre dois casos
 *    que a primeira não pega: a corrida entre o webhook chegar e o `sendAndSave`
 *    terminar de gravar, e o envio em que a Evolution não devolveu `key.id`
 *    (aí a mensagem da Leia foi gravada com `evolution_msg_id` nulo).
 */
async function registrarMensagemDeSaida({ phone, content, contentType, evolutionMsgId }) {
  const contact = await getOrCreateContact(phone);
  const conversation = await getOrCreateConversation(contact.id);

  if (evolutionMsgId) {
    const { data: mesmoId } = await supabase
      .from('wa_messages')
      .select('id')
      .eq('evolution_msg_id', evolutionMsgId)
      .limit(1);

    if (mesmoId?.length) {
      logger.debug('[webhook] Eco do nosso próprio envio (id já registrado)');
      return;
    }
  }

  // 3ª checagem: a fila mandou isto?
  //
  // As duas de cima só enxergam o que JÁ foi gravado, e o
  // `queue-processor` grava DEPOIS de enviar — são três idas ao banco entre
  // o envio e o registro. O eco da Evolution é local e chega no meio desse
  // intervalo com frequência.
  //
  // Antes isso só movia o funil para `com_consultor` indevidamente. Agora
  // que escrever do aparelho CALA a Leia, o mesmo erro silenciaria o
  // atendimento justamente para quem acabou de receber a campanha — e a
  // pessoa responderia "sim" para o vazio.
  //
  // A fila é a fonte certa aqui: ela tem a linha desde antes do envio.
  const desdeFila = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: daFila } = await supabase
    .from('wa_message_queue')
    .select('id, source_app')
    .eq('phone', normalizePhone(phone))
    .eq('content', content)
    .in('status', ['processing', 'sent'])
    .gte('scheduled_for', desdeFila)
    .limit(1);

  if (daFila?.length) {
    logger.debug(`[webhook] Eco de envio da fila (${daFila[0].source_app}) — ignorado`);
    return;
  }

  const desde = new Date(Date.now() - 30_000).toISOString();
  const { data: mesmoTexto } = await supabase
    .from('wa_messages')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('direction', 'outbound')
    .eq('content', content)
    .gte('created_at', desde)
    .limit(1);

  if (mesmoTexto?.length) {
    logger.debug('[webhook] Eco do nosso próprio envio (mesmo texto agora há pouco)');
    return;
  }

  await saveMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    direction: 'outbound',
    content,
    contentType,
    sentBy: 'human:whatsapp',
    evolutionMsgId: evolutionMsgId || null,
    status: 'sent',
  });

  // Consultor digitando no aparelho é o sinal mais confiável de que ele
  // assumiu o atendimento — mais do que qualquer botão no painel, que ele
  // pode nunca clicar.
  //
  // E por isso a Leia CALA. Até 25/08/2026 isto movia só a etapa do funil e
  // deixava `wa_conversations.status` como estava, então a conversa
  // continuava valendo como automática: o consultor escrevia do aparelho, o
  // cliente respondia, e a Leia respondia junto.
  //
  // Aconteceu com a Gisleide nesse dia. A consultora abriu a conversa às
  // 12h19 pelo aparelho, o cliente respondeu às 12h39, e a Leia entrou no
  // mesmo minuto se apresentando do zero — no meio de um assunto que já
  // estava em andamento e sobre o qual ela não sabia nada. Só parou às
  // 12h42, quando a consultora usou o painel.
  //
  // Vale para conversa que o consultor INICIA, que é o caso que o handoff
  // não cobre: não existe handoff, porque nunca houve atendimento
  // automático ali. Para voltar a automática, o caminho é o mesmo de sempre
  // — o botão de reativar, no painel.
  if (conversation.status !== 'human') {
    await supabase
      .from('wa_conversations')
      .update({ status: 'human', ai_enabled: false })
      .eq('id', conversation.id);

    logger.info(
      `[webhook] Consultor escreveu do aparelho para ${phone} — conversa ${conversation.id} ` +
      'passou para modo humano, a IA não responde até alguém reativar'
    );
  }

  await moverFunil(() => funil.aoConsultorAssumir(contact, { via: 'whatsapp' }));

  logger.info(`[webhook] 👤 consultor → ${phone}: ${content.slice(0, 80)}`);
}

/**
 * Envia texto e salva no histórico.
 *
 * `metadata` existe para a mensagem de despedida do handoff poder carregar
 * a marca `handoff` e o motivo. Sem isso o WhatsApp ficava sem o rastro que
 * a página de teste sempre teve, e a diferença aparecia em dois lugares: o
 * painel não mostrava o briefing na conversa, e a transcrição do
 * `exportar-conversas.js` contava o handoff no cabeçalho sem marcar em que
 * ponto da conversa ele aconteceu.
 */
async function sendAndSave(phone, text, conversationId, contactId, metadata = {}) {
  const result = await sendText(phone, text);

  await saveMessage({
    conversationId,
    contactId,
    direction: 'outbound',
    content: text,
    contentType: 'text',
    sentBy: 'bot',
    evolutionMsgId: result?.key?.id || null,
    status: 'sent',
    metadata,
  });
}

/**
 * Processa atualização de status de mensagem (delivered, read).
 */
async function handleMessageStatus(event) {
  const data = event.data || event;
  const key = data.key || {};
  const status = data.status || data.update?.status;
  const evolutionMsgId = key.id;

  if (!evolutionMsgId || !status) return;

  // Mapeia status da Evolution para nosso enum
  const statusMap = {
    SERVER_ACK: 'sent',
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  };

  const ourStatus = statusMap[status];
  if (!ourStatus) return;

  await supabase
    .from('wa_messages')
    .update({ status: ourStatus })
    .eq('evolution_msg_id', evolutionMsgId);
}

/**
 * Processa atualização de status da conexão.
 */
function handleConnectionUpdate(event) {
  const data = event.data || event;
  const state = data.state || data.status;
  logger.info(`[webhook] 📡 Status da conexão: ${state}`);
}

export default router;
