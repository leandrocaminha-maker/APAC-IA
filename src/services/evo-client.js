/**
 * src/services/evo-client.js
 * Client para a API do EVO / W12 (sistema de gestão da academia).
 *
 * Usa Basic Auth: usuário = DNS, senha = Token.
 * Base: https://evo-integracao-api.w12app.com.br
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { baseUrl, dns, token } = config.evo;
const authHeader = 'Basic ' + Buffer.from(`${dns}:${token}`).toString('base64');

/** Helper para chamadas à API do EVO. */
async function evoFetch(path, options = {}) {
  const fullUrl = `${baseUrl}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    ...options.headers,
  };

  logger.debug(`[evo-w12] ${options.method || 'GET'} ${fullUrl}`);

  const res = await fetch(fullUrl, { ...options, headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(`[evo-w12] ${res.status} ${fullUrl}`, body);
    throw new Error(`EVO API ${res.status}: ${body}`);
  }

  return res.json();
}

// ──────────────────────────────────────────────
// Membros / Prospects
// ──────────────────────────────────────────────

/**
 * Busca membros por filtro (nome, telefone, etc.).
 * @param {object} params - { name, phone, email, take, skip }
 */
export async function searchMembers(params = {}) {
  const qs = new URLSearchParams();
  if (params.name) qs.set('name', params.name);
  if (params.phone) qs.set('phone', params.phone);
  if (params.email) qs.set('email', params.email);
  qs.set('take', String(params.take || 50));
  qs.set('skip', String(params.skip || 0));

  return evoFetch(`/api/v1/members?${qs}`);
}

/**
 * Busca um membro pelo ID.
 */
export async function getMemberById(idMember) {
  return evoFetch(`/api/v1/members/${idMember}`);
}

/**
 * Cadastra um novo prospect/membro no EVO.
 * @param {object} data - { firstName, lastName, email, phone, ... }
 */
export async function createProspect(data) {
  logger.info(`[evo-w12] createProspect: ${data.firstName} ${data.lastName}`);
  return evoFetch('/api/v1/members', {
    method: 'POST',
    body: JSON.stringify({
      ...data,
      // Garante que é prospect
      idMembershipCategory: data.idMembershipCategory || null,
    }),
  });
}

// ──────────────────────────────────────────────
// Atividades / Aulas
// ──────────────────────────────────────────────

/**
 * Lista atividades/aulas disponíveis.
 */
export async function getActivities(params = {}) {
  const qs = new URLSearchParams();
  if (params.take) qs.set('take', String(params.take));
  if (params.skip) qs.set('skip', String(params.skip));

  return evoFetch(`/api/v1/activities?${qs}`);
}

/**
 * Lista a grade horária (schedule) de atividades.
 */
export async function getSchedule(params = {}) {
  const qs = new URLSearchParams();
  if (params.idActivity) qs.set('idActivity', String(params.idActivity));
  if (params.date) qs.set('date', params.date);

  return evoFetch(`/api/v1/activities/schedule?${qs}`);
}

/**
 * Agenda uma aula experimental para um prospect.
 * @param {object} data - { idMember, idActivity, date, ... }
 */
export async function scheduleExperimentalClass(data) {
  logger.info(`[evo-w12] scheduleExperimentalClass: member=${data.idMember}`);
  return evoFetch('/api/v1/activities/schedule/experimental-class', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ──────────────────────────────────────────────
// Serviços / Planos
// ──────────────────────────────────────────────

/**
 * Lista serviços/planos disponíveis.
 */
export async function getServices(params = {}) {
  const qs = new URLSearchParams();
  if (params.take) qs.set('take', String(params.take));
  if (params.skip) qs.set('skip', String(params.skip));

  return evoFetch(`/api/v1/services?${qs}`);
}

// ──────────────────────────────────────────────
// Vendas
// ──────────────────────────────────────────────

/**
 * Lista vendas (retorna apenas do mês atual conforme limitação da API).
 */
export async function getSales(params = {}) {
  const qs = new URLSearchParams();
  if (params.idMember) qs.set('idMember', String(params.idMember));
  if (params.take) qs.set('take', String(params.take));
  if (params.skip) qs.set('skip', String(params.skip));

  return evoFetch(`/api/v1/sales?${qs}`);
}

export const evoClient = {
  searchMembers,
  getMemberById,
  createProspect,
  getActivities,
  getSchedule,
  scheduleExperimentalClass,
  getServices,
  getSales,
};
