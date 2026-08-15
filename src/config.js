/**
 * src/config.js
 * Carrega e valida variáveis de ambiente.
 */
import 'dotenv/config';

function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}

export const config = {
  port: parseInt(env('PORT', '3100'), 10),

  // Evolution API (WhatsApp)
  evolution: {
    url: env('EVOLUTION_API_URL', 'http://evolution:8080'),
    apiKey: env('EVOLUTION_API_KEY', ''),
    instance: env('EVOLUTION_INSTANCE', 'apacademia'),
  },

  // Anthropic (Claude) — cérebro do agente
  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY', ''),
  },

  // Supabase — projeto dedicado ao APAC-IA SALES, separado do AQUAP.
  // Nenhuma tabela wa_* referencia tabela do AQUAP: o vínculo com aluno é
  // wa_contacts.evo_member_id, que aponta para a API do EVO.
  //
  // SEM valor padrão de propósito. Um default aqui já apontou para um projeto
  // que depois foi deletado, e o sintoma disso é confuso — melhor falhar no
  // boot dizendo que a variável falta.
  supabase: {
    url: env('SUPABASE_URL', ''),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY', ''),
  },

  // EVO / W12
  evo: {
    dns: env('EVO_API_DNS', 'APACADEMIA'),
    token: env('EVO_API_TOKEN', ''),
    baseUrl: 'https://evo-integracao-api.w12app.com.br',
  },

  // Webhook
  webhookSecret: env('WEBHOOK_SECRET', ''),

  // Chave das rotas /admin (leitura de conversas, QR code do WhatsApp).
  // Sem fallback de propósito: se não estiver definida, /admin é bloqueado.
  adminApiKey: env('ADMIN_API_KEY', ''),

  // API keys dos apps irmãos
  appKeys: {
    aquap: process.env.APP_API_KEY_AQUAP || '',
    pagtos: process.env.APP_API_KEY_PAGTOS || '',
    nfse: process.env.APP_API_KEY_NFSE || '',
  },
};
