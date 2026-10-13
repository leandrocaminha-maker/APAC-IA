/**
 * src/services/pesquisa.js
 * A pesquisa de satisfação pelo número alternativo: o que fazer com quem
 * responde, e o link de quem não respondeu.
 *
 * As regras — os textos, a leitura da resposta, o que cada etapa pede —
 * estão em `pesquisa-regras.js`, puras e testadas. Aqui fica o que toca
 * banco e WhatsApp.
 *
 * ## O caminho de uma pessoa
 *
 *   1. O EVO manda o segmento (`campanhas.absorverSegmentacao`): alvo `pendente`.
 *   2. `campanhas.processarCampanha` agenda a ABERTURA, dentro do teto do
 *      dia do número alternativo: alvo `agendado`, etapa `pesquisa_aguardando`.
 *   3. A pista do número alternativo (`queue-processor`) envia; a
 *      reconciliação marca `enviado`.
 *   4. A pessoa responde → este arquivo, pelo webhook: o LINK vai na hora.
 *      Ou não responde → `agendarLinksSemResposta`, se a campanha tiver
 *      `link_espera_min`; sem ele, quem não respondeu não recebe link.
 *
 * ## O que este número NÃO faz
 *
 * Não conversa. Não há Leia aqui, nem funil, nem handoff, nem contato criado
 * no painel. Cada pessoa ouve no máximo a abertura, o link e uma resposta
 * fixa; depois disso, silêncio — e quem escreve sem ser alvo recebe, uma vez
 * por dia, o aviso de que o atendimento é no outro número. O aparelho do
 * número alternativo continua sendo um WhatsApp: quem estiver com ele lê e
 * responde à mão o que fugir disto.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { ehPedidoDeSaida, enfileirar, estaSuprimido, suprimidosEntre } from './campanhas.js';
import { numeroAlternativo } from './numero-alternativo.js';
import {
  ETAPA, ORIGEM_AUTO, PREFIXO_ALT, PREFIXO_ETAPA, PREFIXO_LINK,
  decidirResposta, formasDoTelefone, lerMensagemRecebida, lerResposta, origemLink, textoDoLink, textoFixo,
} from './pesquisa-regras.js';

const numeroPrincipal = () => config.whatsapp.numeroPrincipal;

/** Logo depois do link, a segunda mensagem da pessoa é o resto da primeira. */
const MESMO_TURNO_MS = 90_000;

// ──────────────────────────────────────────────
// Banco
// ──────────────────────────────────────────────

/** O alvo de pesquisa mais recente deste telefone que já recebeu a abertura. */
async function alvoDaPesquisa(phone) {
  const { data } = await supabase
    .from('crm_campanha_alvos')
    .select('*, campanha:crm_campanhas(*)')
    .in('phone', formasDoTelefone(phone))
    .like('etapa_conversa', `${PREFIXO_ETAPA}%`)
    .in('status', ['enviado', 'respondeu', 'suprimido'])
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Move o alvo de etapa, só se ele ainda estiver onde se pensa.
 *
 * É a trava contra o link em dobro: o webhook (a pessoa respondeu) e o
 * worker (o prazo venceu) podem chegar ao mesmo alvo no mesmo segundo, e
 * quem perde a corrida recebe `false` e não envia.
 */
async function moverEtapa(alvo, para, extra = {}) {
  const { data } = await supabase
    .from('crm_campanha_alvos')
    .update({ etapa_conversa: para, ...extra })
    .eq('id', alvo.id)
    .eq('etapa_conversa', alvo.etapa_conversa)
    .select('id');
  return Boolean(data?.length);
}

/** Restringe uma operação na fila ao que ainda não saiu para este telefone, pela pista alternativa. */
const pendentesDoTelefone = (operacao, phone, prefixo) => operacao
  .eq('status', 'pending')
  .in('phone', formasDoTelefone(phone))
  .like('source_app', `${prefixo}%`);

const fila = () => supabase.from('wa_message_queue');

// ──────────────────────────────────────────────
// Quem respondeu
// ──────────────────────────────────────────────

const responder = (phone, qual) => numeroAlternativo.enviar(
  phone, textoFixo(qual, { numeroPrincipal: numeroPrincipal() }), { tipo: 'auto', origem: ORIGEM_AUTO },
);

/**
 * A pessoa pediu SAIR ao número alternativo.
 *
 * Fica no alvo (`pesquisa_saiu`), não em `crm_supressoes` — ver
 * `saiuDaPesquisa`, em `campanhas.js`, para o porquê. O `suprimido` é o que
 * a guarda automática da campanha conta: gente demais pedindo para sair
 * pausa a pesquisa antes de a Meta reagir.
 */
async function sair(phone, alvo) {
  if (alvo) {
    await supabase
      .from('crm_campanha_alvos')
      .update({ status: 'suprimido', etapa_conversa: ETAPA.saiu, replied_at: new Date().toISOString() })
      .eq('id', alvo.id);
  }

  await pendentesDoTelefone(fila().delete(), phone, PREFIXO_ALT);
}

async function mandarLink(phone, alvo) {
  const texto = textoDoLink(alvo, alvo.campanha, { numeroPrincipal: numeroPrincipal() });
  if (!texto) {
    logger.error(`[pesquisa] "${alvo.campanha?.slug}" está sem link — ${phone} pediu e não recebeu`);
    return;
  }

  if (!(await moverEtapa(alvo, ETAPA.link))) return;   // o worker chegou antes: o link já está na fila

  try {
    await numeroAlternativo.enviar(phone, texto, { tipo: 'link', origem: origemLink(alvo.campanha.slug) });
  } catch (err) {
    // Não saiu: a pessoa volta para onde estava, e o próximo "sim" tenta de novo.
    await supabase.from('crm_campanha_alvos').update({ etapa_conversa: alvo.etapa_conversa }).eq('id', alvo.id);
    throw err;
  }
}

async function tratarMensagem(m) {
  // A segunda entrega do mesmo evento não é uma segunda mensagem.
  if (await numeroAlternativo.jaRegistrada(m.id)) return;

  logger.info(`[pesquisa] 📩 ${m.phone}: ${m.content.slice(0, 80)}`);
  await numeroAlternativo.registrar({
    phone: m.phone, direction: 'inbound', tipo: 'recebida',
    content: m.content, evolutionMsgId: m.id, status: 'delivered',
  });

  // Quem pediu para sair ao número principal não ouve mais nada da academia,
  // por número nenhum — nem resposta fixa.
  if (await estaSuprimido(m.phone)) return;

  const alvo = await alvoDaPesquisa(m.phone);
  const { acao, etapa } = decidirResposta({
    etapa: alvo?.etapa_conversa ?? null,
    pedidoDeSaida: ehPedidoDeSaida(m.content),
    resposta: lerResposta(m.content),
  });

  logger.info(`[pesquisa] ${m.phone} em "${alvo?.etapa_conversa ?? 'sem alvo'}" → ${acao}`);

  // A primeira resposta encerra o silêncio do alvo, seja qual for.
  if (alvo?.status === 'enviado' && acao !== 'sair') {
    await supabase
      .from('crm_campanha_alvos')
      .update({ status: 'respondeu', replied_at: new Date().toISOString() })
      .eq('id', alvo.id);
  }

  switch (acao) {
    case 'sair':
      await sair(m.phone, alvo);
      await responder(m.phone, 'saida');
      return;

    case 'link':
      await mandarLink(m.phone, alvo);
      return;

    case 'recusar':
      await pendentesDoTelefone(fila().delete(), m.phone, PREFIXO_LINK);
      if (await moverEtapa(alvo, etapa)) await responder(m.phone, 'recusa');
      return;

    case 'esclarecer':
      if (await moverEtapa(alvo, etapa)) await responder(m.phone, 'esclarecimento');
      return;

    case 'encerrar': {
      // O link saiu por prazo e ainda está na fila: a resposta o adianta, e
      // não há o que agradecer antes de ele chegar.
      const { data: adiantados } = await pendentesDoTelefone(
        fila().update({ scheduled_for: new Date().toISOString() }), m.phone, PREFIXO_LINK,
      ).select('id');
      if (adiantados?.length) return;

      // "sim" e "pode mandar" em dois balões: o segundo é o mesmo turno.
      if (Date.now() - new Date(alvo.updated_at).getTime() < MESMO_TURNO_MS) return;

      if (await moverEtapa(alvo, etapa)) await responder(m.phone, 'encerramento');
      return;
    }

    case 'aviso':
      if (await numeroAlternativo.respondeuHaPouco(m.phone)) return;
      await responder(m.phone, 'aviso');
      return;

    default:   // 'silencio'
  }
}

/**
 * Uma mensagem de cada vez por telefone.
 *
 * "Sim" e "pode mandar" chegam com meio segundo de diferença, em dois
 * eventos. Tratados juntos, os dois leriam a mesma etapa e mandariam o link
 * duas vezes; em fila, o segundo já encontra o link enviado.
 */
const emCurso = new Map();

function umaPorVez(phone, tarefa) {
  const anterior = emCurso.get(phone) ?? Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  emCurso.set(phone, atual);
  atual.catch(() => {}).finally(() => {
    if (emCurso.get(phone) === atual) emCurso.delete(phone);
  });
  return atual;
}

/**
 * Um evento do webhook da Evolution que veio da instância alternativa.
 * Quem chama é `routes/webhook.js`, antes de qualquer coisa do número
 * principal — nada daqui passa pelo funil nem pela Leia.
 */
export async function tratarEvento(evento) {
  const tipo = String(evento?.event || evento?.type || '').toLowerCase().replace(/_/g, '.');

  if (tipo === 'messages.upsert') {
    const m = lerMensagemRecebida(evento);
    // `fromMe` é o eco do que saiu por aqui, ou alguém escrevendo do aparelho.
    if (!m || m.fromMe) return;
    if (!m.phone) {
      logger.warn('[pesquisa] Mensagem ao número alternativo sem telefone legível (conta com LID) — ' +
        'não dá para achar o alvo; fica para quem estiver com o aparelho');
      return;
    }
    await umaPorVez(m.phone, () => tratarMensagem(m));
    return;
  }

  if (tipo === 'messages.update') {
    const data = evento.data || evento;
    const id = data.key?.id || data.keyId;
    const status = {
      SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read',
    }[data.status || data.update?.status];
    if (id && status) await numeroAlternativo.atualizarStatus(id, status);
    return;
  }

  if (tipo === 'connection.update') {
    const data = evento.data || evento;
    numeroAlternativo.anotarConexao(data.state || data.status);
  }
}

// ──────────────────────────────────────────────
// Quem não respondeu
// ──────────────────────────────────────────────

/**
 * Agenda o link de quem recebeu a abertura e não respondeu no prazo da
 * campanha (`link_espera_min`). Sem prazo na campanha, não faz nada: só
 * recebe o link quem respondeu.
 *
 * Roda a cada ciclo do worker de campanha e olha UM CICLO À FRENTE: o link
 * é agendado para o minuto em que o prazo daquela pessoa vence, e não para
 * a hora do ciclo — senão as aberturas espalhadas pelo dia virariam um
 * monte de links de dez em dez minutos.
 *
 * Campanha pausada não agenda link. Concluída agenda: ela conclui quando a
 * última abertura sai, e os prazos dessas ainda estão correndo.
 *
 * @returns {Promise<number>} quantos links foram agendados
 */
export async function agendarLinksSemResposta(agora = new Date()) {
  if (!numeroAlternativo.configurado() || config.campanha.dryRun) return 0;

  const { data: campanhas, error } = await supabase
    .from('crm_campanhas')
    .select('*')
    .eq('finalidade', 'pesquisa')
    .in('status', ['ativa', 'concluida'])
    .not('link_espera_min', 'is', null);

  if (error) {
    // PGRST204/42703 aqui é a migration 019 por aplicar.
    logger.warn('[pesquisa] Não consegui ler as pesquisas (a migration 019 foi aplicada?):', error.message);
    return 0;
  }

  let agendados = 0;

  for (const campanha of campanhas ?? []) {
    if (!campanha.link) continue;

    const esperaMs = Math.max(0, campanha.link_espera_min) * 60_000;
    const venceAte = new Date(agora.getTime() + config.campanha.minutos * 60_000 - esperaMs).toISOString();

    const { data: alvos } = await supabase
      .from('crm_campanha_alvos')
      .select('*')
      .eq('campanha_id', campanha.id)
      .eq('status', 'enviado')
      .eq('etapa_conversa', ETAPA.aguardando)
      .lte('sent_at', venceAte)
      .order('sent_at', { ascending: true })
      .limit(100);

    if (!alvos?.length) continue;

    const suprimidos = await suprimidosEntre(alvos.map(a => a.phone));

    for (const alvo of alvos) {
      if (suprimidos.has(alvo.phone)) continue;

      const texto = textoDoLink(alvo, campanha, { numeroPrincipal: numeroPrincipal(), semResposta: true });
      const quando = new Date(Math.max(agora.getTime(), new Date(alvo.sent_at).getTime() + esperaMs));

      // A etapa muda ANTES de enfileirar: se a pessoa responder neste
      // instante, o webhook já a encontra em `pesquisa_link` e não manda
      // outro link.
      if (!(await moverEtapa(alvo, ETAPA.link))) continue;

      const queueId = await enfileirar({
        phone: alvo.phone, texto, quando, origem: origemLink(campanha.slug),
      });

      if (!queueId) {
        await supabase.from('crm_campanha_alvos').update({ etapa_conversa: ETAPA.aguardando }).eq('id', alvo.id);
        continue;
      }
      agendados++;
    }
  }

  if (agendados) logger.info(`[pesquisa] ${agendados} link(s) agendado(s) para quem não respondeu`);
  return agendados;
}

export const pesquisa = { tratarEvento, agendarLinksSemResposta };
