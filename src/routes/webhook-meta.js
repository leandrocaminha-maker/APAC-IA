/**
 * src/routes/webhook-meta.js
 * Recebe os avisos da API oficial do WhatsApp (Cloud API, da Meta).
 *
 * ENSAIO (27/11/2026, PLANO_API_OFICIAL.md). A rota só LÊ e ESCREVE NO LOG:
 * não cria contato, conversa nem lead, não chama a Leia e não responde a
 * ninguém. O que se quer ver no ensaio está nas linhas `[oficial]`:
 *
 *   - `📩` alguém escreveu para o número (e abriu a janela de 24 h);
 *   - `📬` o status do que enviamos — é aqui que a Meta diz se cobrou e em
 *     que categoria, e é daqui que o plano tira o custo por mensagem;
 *   - `❌` o envio que falhou, com o código da Meta.
 *
 * Fechada por padrão: sem `WA_OFICIAL_VERIFY_TOKEN` a verificação é
 * recusada, e sem `WA_OFICIAL_APP_SECRET` todo aviso é recusado.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { assinaturaConfere, lerAviso } from '../services/whatsapp-oficial-regras.js';

const router = Router();

/**
 * GET /webhook/meta — a verificação. A Meta chama uma vez, ao salvar o
 * endereço no painel dela, e espera o `hub.challenge` de volta em texto.
 */
router.get('/', (req, res) => {
  const esperado = config.whatsappOficial.verifyToken;
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];

  if (!esperado || modo !== 'subscribe' || token !== esperado) {
    logger.warn('[oficial] Verificação do webhook recusada (token ausente ou diferente)');
    return res.sendStatus(403);
  }
  logger.info('[oficial] Webhook verificado pela Meta');
  res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
});

/** POST /webhook/meta — os avisos: mensagem recebida e status de envio. */
router.post('/', (req, res) => {
  const { appSecret, numeroId } = config.whatsappOficial;

  // `req.rawBody` é guardado em `server.js`, só para esta rota.
  if (!assinaturaConfere(req.rawBody, req.headers['x-hub-signature-256'], appSecret)) {
    logger.warn('[oficial] Aviso recusado: assinatura ausente ou inválida');
    return res.sendStatus(401);
  }

  // A Meta reenvia o que não recebe 200 em poucos segundos.
  res.sendStatus(200);

  try {
    for (const item of lerAviso(req.body)) {
      // O app pode ter mais de um número (o de teste e, depois, o segundo
      // número). O que não for do configurado é anotado, não escondido.
      const outro = numeroId && item.numeroId !== numeroId ? ` [número ${item.numeroId}]` : '';

      if (item.tipo === 'mensagem') {
        logger.info(
          `[oficial] 📩 ${item.de}${item.nome ? ` (${item.nome})` : ''} — ${item.formato}: ` +
          `${item.conteudo.slice(0, 300)} (id ${item.id})${outro}`,
        );
      } else if (item.status === 'failed') {
        logger.warn(
          `[oficial] ❌ falhou para ${item.para} — Meta ${item.erro?.codigo ?? '?'}: ` +
          `${item.erro?.texto ?? 'sem detalhe'} (id ${item.id})${outro}`,
        );
      } else {
        const preco = item.cobrada === null
          ? ''
          : ` — ${item.cobrada ? 'cobrada' : 'sem cobrança'}, categoria ${item.categoria ?? '?'}`;
        logger.info(`[oficial] 📬 ${item.status} para ${item.para}${preco} (id ${item.id})${outro}`);
      }
    }
  } catch (err) {
    logger.error('[oficial] Falha ao ler o aviso:', err.message);
  }
});

export default router;
