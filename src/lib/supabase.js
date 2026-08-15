/**
 * src/lib/supabase.js
 * Cliente Supabase com service role (bypass RLS).
 * Inclui transport WebSocket do pacote `ws` para compatibilidade total.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config.js';

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
