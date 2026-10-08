/**
 * src/routes/acompanhamento.js
 * As rotas de máquina do acompanhamento: quem chama é o Prescrev.
 *
 *   GET /acompanhamento/encaminhamentos?dias=30
 *       os encaminhamentos dos últimos dias e quem ativou o EQUIPE — a tela
 *       Acompanhamento do Prescrev filtra por quem está logado.
 *
 * Sem login: aceita só requisição assinada com `ACOMPANHAMENTO_SECRET`, o
 * mesmo esquema das rotas do Prescrev que o worker daqui chama
 * (HMAC-SHA256 hex de `${timestamp}.${caminho com a consulta}`, 5 minutos).
 * O encaminhamento traz nome do aluno e motivo: a assinatura é a única coisa
 * entre ele e a internet. Não afrouxe.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { equipeAtivada, listarEncaminhamentos } from '../services/acompanhamento/encaminhamentos.js';

const JANELA_MS = 5 * 60_000;
const router = Router();

/** null = assinatura válida; senão, o motivo da recusa. */
export function conferirAssinatura(segredo, { assinatura, timestamp }, conteudo, agora = Date.now()) {
  if (!assinatura || !timestamp) return 'Requisição não assinada.';
  const idade = Math.abs(agora - Number(timestamp));
  if (!Number.isFinite(idade) || idade > JANELA_MS) return 'Assinatura fora da janela de validade.';
  const a = Buffer.from(String(assinatura), 'utf8');
  const b = Buffer.from(createHmac('sha256', segredo).update(`${timestamp}.${conteudo}`).digest('hex'), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Assinatura inválida.';
  return null;
}

function assinado(req, res, next) {
  const segredo = config.acompanhamento.prescrev.segredo;
  if (!segredo) return res.status(503).json({ error: 'ACOMPANHAMENTO_SECRET não definido.' });
  const recusa = conferirAssinatura(segredo, {
    assinatura: req.get('x-prescrev-signature'),
    timestamp: req.get('x-prescrev-timestamp'),
  }, req.originalUrl);
  if (recusa) {
    logger.warn(`[acompanhamento] ${req.originalUrl} recusada: ${recusa}`);
    return res.status(401).json({ error: recusa });
  }
  next();
}

router.get('/encaminhamentos', assinado, async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias || '30', 10) || 30, 1), 90);
    const [encaminhamentos, ativos] = await Promise.all([listarEncaminhamentos({ dias }), equipeAtivada()]);
    res.json({
      encaminhamentos,
      // Sem o número: o Prescrev só precisa saber quem ativou.
      ativados: ativos.map(a => ({ profile_id: a.profile_id, nome: a.nome, papel: a.papel, ativado_em: a.ativado_em })),
    });
  } catch (err) {
    logger.error('[acompanhamento] Encaminhamentos ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
