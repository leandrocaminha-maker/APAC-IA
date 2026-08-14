/**
 * src/config.js
 * Carrega e valida variáveis de ambiente.
 */
import 'dotenv/config';

function env(key, fallback) {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Variável de ambiente obrigatória: ${key}`);
  return v;
}

export const config = {
  port: parseInt(env('PORT', '3100'), 10),

  // Evolution API (WhatsApp)
  evolution: {
    url: env('EVOLUTION_API_URL', 'http://localhost:8080'),
    apiKey: env('EVOLUTION_API_KEY'),
    instance: env('EVOLUTION_INSTANCE', 'apacademia'),
  },

  // Google AI (Gemini)
  gemini: {
    apiKey: env('GOOGLE_AI_API_KEY'),
  },

  // Supabase
  supabase: {
    url: env('SUPABASE_URL'),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  },

  // EVO / W12
  evo: {
    dns: env('EVO_API_DNS', 'APACADEMIA'),
    token: env('EVO_API_TOKEN'),
    baseUrl: 'https://evo-integracao-api.w12app.com.br',
  },

  // Webhook
  webhookSecret: env('WEBHOOK_SECRET', ''),

  // API keys dos apps irmãos
  appKeys: {
    aquap: process.env.APP_API_KEY_AQUAP || '',
    pagtos: process.env.APP_API_KEY_PAGTOS || '',
    nfse: process.env.APP_API_KEY_NFSE || '',
  },
};
