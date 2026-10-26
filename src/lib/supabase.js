/**
 * src/lib/supabase.js
 * Cliente Supabase com service role (bypass RLS).
 * Inclui transport WebSocket do pacote `ws` para compatibilidade total.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Confere se a chave pertence ao MESMO projeto da URL, e se é service_role.
 *
 * Uma chave válida mas de outro projeto não falha na autenticação: ela
 * responde PGRST205 ("Could not find the table ... in the schema cache"),
 * que parece migration não aplicada e é caro de diagnosticar. Melhor gritar
 * no boot.
 */
function checarProjeto(url, key) {
  if (!url) {
    logger.error('[supabase] SUPABASE_URL não definida — configure no .env');
    return;
  }

  if (!key) {
    logger.error('[supabase] SUPABASE_SERVICE_ROLE_KEY vazia — nenhuma query vai funcionar');
    return;
  }

  // Chaves novas (sb_secret_...) não são JWT e não carregam o ref; nada a conferir.
  if (!key.startsWith('eyJ')) return;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString());
  } catch {
    logger.warn('[supabase] Não foi possível decodificar a chave para conferência');
    return;
  }

  const refDaUrl = new URL(url).hostname.split('.')[0];

  if (payload.ref && payload.ref !== refDaUrl) {
    logger.error(
      `[supabase] Chave e URL são de projetos DIFERENTES — URL aponta para "${refDaUrl}", ` +
      `mas a chave é do projeto "${payload.ref}". As tabelas vão responder PGRST205 ` +
      '("not found in schema cache") como se a migration não tivesse rodado.'
    );
  }

  if (payload.role !== 'service_role') {
    logger.error(
      `[supabase] A chave tem role "${payload.role}", e não "service_role". ` +
      'O backend depende de ignorar o RLS — com esta chave as tabelas wa_* ficam inacessíveis.'
    );
  }
}

checarProjeto(config.supabase.url, config.supabase.serviceRoleKey);

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false },
    realtime: {
      transport: WebSocket,
    },
  }
);

/** O máximo de linhas que o PostgREST deste projeto devolve por resposta. */
const LINHAS_POR_RESPOSTA = 1000;

/**
 * Lê TODAS as linhas de uma consulta, de mil em mil.
 *
 * O PostgREST corta toda resposta em 1000 linhas, e corta calado: sem erro,
 * com `content-range: 0-999/*`. Em 26/10/2026 `crm_leads` tinha 1.174
 * linhas, e as métricas do painel contavam só 1.000 delas — 191 leads
 * abertos em vez de 290. E as que sumiam não eram quaisquer: sem `order`, o
 * Postgres devolve na ordem física, e linha atualizada vai para o fim.
 * Sumiam justamente os leads mais mexidos.
 *
 * `montar` devolve a consulta já filtrada, e é chamada uma vez por página:
 * o builder do supabase-js não se reaproveita depois de executado. A ordem
 * por `id` é o que mantém as páginas estáveis entre uma chamada e outra.
 *
 * Use em toda consulta que conta ou soma uma tabela inteira.
 *
 * @param {() => object} montar  ex.: `() => supabase.from('crm_leads').select('stage')`
 * @returns {Promise<{data: object[]|null, error: object|null}>}
 */
export async function lerTodas(montar, { teto = 100_000 } = {}) {
  const linhas = [];
  for (let de = 0; de < teto; de += LINHAS_POR_RESPOSTA) {
    const { data, error } = await montar()
      .order('id', { ascending: true })
      .range(de, de + LINHAS_POR_RESPOSTA - 1);
    if (error) return { data: null, error };
    linhas.push(...(data || []));
    if (!data || data.length < LINHAS_POR_RESPOSTA) return { data: linhas, error: null };
  }
  logger.warn(`[supabase] lerTodas parou no teto de ${teto} linhas — a contagem está incompleta`);
  return { data: linhas, error: null };
}
