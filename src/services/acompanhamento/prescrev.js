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
export const FICHA_VERSAO_LIDA = 4;
/** 2 (M2 do PLANO_MODELOS): a rotina por degrau traz `degrau` e `fase`, e há situações novas. */
export const MODELOS_VERSAO_LIDA = 3;

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

/**
 * As fichas completas da unidade, e a rodada de sessões da semana (M5:
 * `sessoes`, da unidade — o ciclo, se ele teve rodada bem-sucedida, a última
 * tentativa). @returns {Promise<{fichas: object[], sem_ficha: number, sessoes: object|null}>}
 */
export async function buscarFichas() {
  const r = await buscar('/api/acompanhamento/fichas');
  const nova = (r.fichas ?? []).find(f => f.versao > FICHA_VERSAO_LIDA);
  if (nova) {
    throw new Error(`Ficha na versão ${nova.versao}, e este código lê até a ${FICHA_VERSAO_LIDA}: atualize o APAC.`);
  }
  return { fichas: r.fichas ?? [], sem_ficha: r.sem_ficha ?? 0, sessoes: r.sessoes ?? null };
}

/** Só a rodada de sessões da semana, sem as fichas: o aviso de falha confere a cada ciclo do worker. */
export async function buscarSituacaoDasSessoes() {
  const r = await buscar('/api/acompanhamento/fichas?so=sessoes');
  return r.sessoes ?? null;
}

/** A versão da lista de relatórios em PDF que este código sabe ler (RELATORIOS_VERSION do Prescrev). */
export const RELATORIOS_VERSAO_LIDA = 1;

/**
 * Os relatórios em PDF publicados no Prescrev (migration 054 de lá), só de
 * quem mantém o aceite, com a frase que vai junto de cada um.
 * @returns {Promise<{relatorios: object[], mensagens: Record<string, string>, migracao: boolean}>}
 */
export async function buscarRelatorios() {
  const r = await buscar('/api/acompanhamento/relatorios');
  if (r.versao > RELATORIOS_VERSAO_LIDA) {
    throw new Error(`Relatórios na versão ${r.versao}, e este código lê até a ${RELATORIOS_VERSAO_LIDA}: atualize o APAC.`);
  }
  return { relatorios: r.relatorios ?? [], mensagens: r.mensagens ?? {}, migracao: r.migracao !== false };
}

/** O PDF de um relatório publicado. @returns {Promise<{id: string, nome_arquivo: string, mimetype: string, base64: string}>} */
export async function baixarRelatorio(id) {
  return buscar(`/api/acompanhamento/relatorios?id=${encodeURIComponent(id)}`);
}

/** A versão da agenda dos testes que este código sabe ler (AGENDA_TESTES_VERSION do Prescrev). */
export const AGENDA_TESTES_VERSAO_LIDA = 1;

/**
 * As sessões de aplicação dos testes do dia, canceladas inclusive (Prescrev
 * 060), para o aviso a cada professor. `dia` "AAAA-MM-DD"; sem ele, hoje.
 * @returns {Promise<{dia: string, marcacoes: object[], migracao: boolean}>}
 */
export async function buscarAgendaDeTestes(dia = null) {
  const r = await buscar(`/api/acompanhamento/agenda-testes${dia ? `?dia=${encodeURIComponent(dia)}` : ''}`);
  if (r.versao > AGENDA_TESTES_VERSAO_LIDA) {
    throw new Error(`Agenda dos testes na versão ${r.versao}, e este código lê até a ${AGENDA_TESTES_VERSAO_LIDA}: atualize o APAC.`);
  }
  return { dia: r.dia, marcacoes: r.marcacoes ?? [], migracao: r.migracao !== false };
}

/** Os modelos publicados. @returns {Promise<{versao: number, marcadores: object[], modelos: object[]}>} */
export async function buscarModelos() {
  const r = await buscar('/api/acompanhamento/modelos');
  if (r.versao > MODELOS_VERSAO_LIDA) {
    throw new Error(`Modelos na versão ${r.versao}, e este código lê até a ${MODELOS_VERSAO_LIDA}: atualize o APAC.`);
  }
  return r;
}

/**
 * O questionário de quem tem avaliação marcada já chegou ao Prescrev?
 * (`/api/acompanhamento/questionario`, 03/11/2026). Conta pelo cadastro
 * vinculado ao EVO e, sem vínculo, pelo e-mail; só o que chegou desde `desde`.
 * @returns {Promise<{recebido: boolean, em: string|null, por: 'cadastro'|'email'|null}>}
 */
export async function questionarioRecebido({ evo, email, desde }) {
  const q = new URLSearchParams();
  if (evo) q.set('evo', String(evo));
  if (email) q.set('email', String(email));
  if (desde) q.set('desde', desde);
  return buscar(`/api/acompanhamento/questionario?${q}`);
}

const EQUIPE_CACHE_MS = 5 * 60_000;
let cacheEquipe = { em: 0, equipe: null };

/**
 * A equipe da unidade: quem pode receber encaminhamentos, com o código
 * EQUIPE de cada um (que vale como senha), o papel, o e-mail e o horário
 * de trabalho. Guardada 5 minutos — a porta do webhook e o worker a leem a
 * toda hora; `fresca` busca de novo (código recém-gerado).
 * @returns {Promise<object[]>}
 */
export async function buscarEquipe({ fresca = false } = {}) {
  if (!fresca && cacheEquipe.equipe && Date.now() - cacheEquipe.em < EQUIPE_CACHE_MS) return cacheEquipe.equipe;
  const r = await buscar('/api/acompanhamento/equipe');
  cacheEquipe = { em: Date.now(), equipe: r.equipe ?? [] };
  return cacheEquipe.equipe;
}
