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
