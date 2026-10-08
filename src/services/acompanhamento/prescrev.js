/**
 * src/services/acompanhamento/prescrev.js
 * A busca das fichas e dos modelos no Prescrev.
 *
 * As duas rotas do Prescrev (/api/acompanhamento/fichas e /modelos) não
 * têm login: aceitam só requisição assinada com o segredo que as duas
 * pontas conhecem (`ACOMPANHAMENTO_SECRET`, o mesmo valor no `.env` daqui e
 * no do Prescrev). A assinatura é HMAC-SHA256 de `${timestamp}.${caminho}`,
 * com o caminho exatamente como vai na requisição, e vale 5 minutos — o
 * relógio da VPS precisa estar certo, e está (é a mesma máquina).
 *
 * O formato tem versão. Ficha ou modelo de versão que este código não
 * conhece é recusado: ler um campo que mudou de sentido em silêncio
 * mandaria mensagem errada para aluno.
 */
import { createHmac } from 'node:crypto';
import { config } from '../../config.js';

/** As versões que este código sabe ler (FICHA_VERSION e MODELOS_VERSION do Prescrev). */
export const FICHA_VERSAO_LIDA = 3;
export const MODELOS_VERSAO_LIDA = 1;

async function buscar(caminho) {
  const { url, segredo } = config.acompanhamento.prescrev;
  if (!url || !segredo) throw new Error('PRESCREV_URL ou ACOMPANHAMENTO_SECRET não definidos');

  const timestamp = String(Date.now());
  const assinatura = createHmac('sha256', segredo).update(`${timestamp}.${caminho}`).digest('hex');
  const r = await fetch(url.replace(/\/$/, '') + caminho, {
    headers: { 'x-prescrev-timestamp': timestamp, 'x-prescrev-signature': assinatura },
    signal: AbortSignal.timeout(20_000),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Prescrev ${caminho}: HTTP ${r.status}${corpo.error ? ` — ${corpo.error}` : ''}`);
  return corpo;
}

/** As fichas completas da unidade. @returns {Promise<{fichas: object[], sem_ficha: number}>} */
export async function buscarFichas() {
  const r = await buscar('/api/acompanhamento/fichas');
  const nova = (r.fichas ?? []).find(f => f.versao > FICHA_VERSAO_LIDA);
  if (nova) {
    throw new Error(`Ficha na versão ${nova.versao}, e este código lê até a ${FICHA_VERSAO_LIDA}: atualize o APAC.`);
  }
  return { fichas: r.fichas ?? [], sem_ficha: r.sem_ficha ?? 0 };
}

/** Os modelos publicados. @returns {Promise<{versao: number, marcadores: object[], modelos: object[]}>} */
export async function buscarModelos() {
  const r = await buscar('/api/acompanhamento/modelos');
  if (r.versao > MODELOS_VERSAO_LIDA) {
    throw new Error(`Modelos na versão ${r.versao}, e este código lê até a ${MODELOS_VERSAO_LIDA}: atualize o APAC.`);
  }
  return r;
}
