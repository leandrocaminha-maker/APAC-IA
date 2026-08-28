/**
 * src/services/whatsapp-monitor.js
 * Vigia a sessão do WhatsApp e avisa quando ela cai.
 *
 * ## O incidente que fez isto existir
 *
 * Em 28/08/2026 a sessão caiu às 16:43 e ninguém percebeu por **2h30**. O
 * container estava de pé, a Evolution respondia HTTP 200 — o que tinha
 * morrido era o pareamento com o WhatsApp. E o pior não era o envio: a
 * ENTRADA parou junto. Por 2h30 ninguém conseguiu falar com a academia, e
 * não dá nem para saber quem tentou.
 *
 * ## Por que o alerta não sai pelo WhatsApp
 *
 * Porque o WhatsApp é justamente o que está fora. Mandar aviso pelo canal
 * que caiu é o erro clássico de monitoração, e aqui ele seria total: a
 * mensagem entraria em `wa_message_queue`, falharia com "Connection
 * Closed", e o aviso da queda seria mais uma vítima da queda.
 *
 * O canal é o painel. `pendencias()` já é consultado de minuto em minuto
 * por todo painel aberto — pendurar o estado da conexão nessa resposta faz
 * o aviso chegar a quem está trabalhando sem infra nova. É pull, não push,
 * mas troca 2h30 por 1 minuto.
 *
 * ## O estado fica em memória, e tudo bem
 *
 * Não vai para `crm_controle` porque não precisa sobreviver a restart: ao
 * subir, a primeira sondagem em 20s redescobre a verdade do zero. O que
 * um restart apaga é só a hora da queda, e essa está no log.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getConnectionStatus } from './evolution.js';

/**
 * `estado` guarda o que a última sondagem viu.
 *
 * `desconhecido` é diferente de `close`: significa que a Evolution não
 * respondeu, e o painel precisa dizer isso em vez de afirmar que o
 * WhatsApp caiu — são problemas diferentes, com soluções diferentes.
 */
let atual = {
  estado: 'desconhecido',
  desde: null,          // quando o estado atual começou
  verificadoEm: null,
  quedaEm: null,        // início da queda em curso; null se está no ar
  ultimoErro: null,
};

/** Instantâneo para quem for exibir. Cópia, para ninguém mutar por engano. */
export function conexaoWhatsapp() {
  const foraDoAr = atual.estado !== 'open';
  return {
    ...atual,
    conectado: atual.estado === 'open',
    // Minutos fora do ar, para o painel decidir o quanto gritar.
    foraHaMin: foraDoAr && atual.quedaEm
      ? Math.floor((Date.now() - atual.quedaEm.getTime()) / 60_000)
      : 0,
  };
}

/** Lê a Evolution e registra a transição, se houve. */
async function sondar() {
  let novo;
  let erro = null;

  try {
    const r = await getConnectionStatus();
    novo = r?.instance?.state || r?.state || 'desconhecido';
  } catch (err) {
    novo = 'desconhecido';
    erro = err.message;
  }

  const agora = new Date();
  const anterior = atual.estado;
  const mudou = novo !== anterior;

  atual = {
    estado: novo,
    desde: mudou ? agora : (atual.desde ?? agora),
    verificadoEm: agora,
    quedaEm: novo === 'open' ? null : (atual.quedaEm ?? agora),
    ultimoErro: erro,
  };

  if (!mudou) return;

  if (novo === 'open') {
    // `anterior` na primeira sondagem é 'desconhecido', que não é queda —
    // por isso a duração só é anunciada quando havia queda de fato.
    logger.info(
      `[whatsapp] Sessão CONECTADA${anterior !== 'desconhecido' ? ` (estava "${anterior}")` : ''}`
    );
  } else {
    logger.error(
      `[whatsapp] ⚠️ SESSÃO FORA DO AR — estado "${novo}"${erro ? ` (${erro})` : ''}. ` +
      'Nada entra e nada sai: mensagem de cliente não chega, e o que sair falha. ' +
      'Parear em crm.apacademia.com.br → Ajustes → WhatsApp → Gerar QR code.'
    );
  }
}

/**
 * Sobe o vigia.
 *
 * Primeira sondagem em 20s — antes dos outros workers, de propósito: se a
 * sessão subiu quebrada, é a primeira coisa que o log deve dizer.
 */
export function startWhatsappMonitor() {
  const minutos = config.whatsapp.monitorMinutos;

  if (minutos <= 0) {
    logger.info('[whatsapp] Monitor desligado (WHATSAPP_MONITOR_MINUTOS=0)');
    return;
  }

  logger.info(`[whatsapp] Monitor iniciado (sonda a cada ${minutos} min)`);
  setTimeout(() => { sondar().catch(() => {}); }, 20_000);
  setInterval(() => { sondar().catch(() => {}); }, minutos * 60_000);
}

export const whatsappMonitor = { conexaoWhatsapp, startWhatsappMonitor };
