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

    // Filial. 1 = AP ACADEMIA - PIRITUBA, confirmado em /api/v1/prospects.
    idBranch: parseInt(env('EVO_ID_BRANCH', '1'), 10),

    // Como o lead vindo da Leia aparece no relatório de origem do EVO.
    // O campo é usado de verdade na conta (INDICAÇÃO, WEBSITE / GOOGLE,
    // INSTAGRAN...), então vale entrar com um valor próprio em vez de cair
    // no "-NÃO INFORMADO", que hoje é 42% dos cadastros.
    canalMarketing: env('EVO_CANAL_MARKETING', 'WHATSAPP / LEIA'),

    // Guarda de ensaio: com true, nenhuma escrita sai daqui — cadastro de
    // prospect, agendamento e venda só são registrados no log e devolvem
    // { dryRun: true }. Serve para percorrer o fluxo do painel inteiro sem
    // sujar o sistema de produção da academia. Leitura continua real.
    dryRun: env('EVO_DRY_RUN', 'false') === 'true',

    // Depois de quantos meses sem contrato um ex-aluno volta a ser lead.
    //
    // O EVO não faz esse caminho de volta: uma vez `member`, sempre `member`,
    // mesmo sem contrato desde 2021. Como a academia trata quem sumiu há mais
    // de 3 meses como oportunidade nova — e é assim que o painel opera —,
    // quem passa deste prazo volta a receber o fluxo de lead, incluindo aula
    // experimental.
    mesesReativacao: parseInt(env('EVO_MESES_REATIVACAO', '3'), 10),

    // Intervalo do worker que reconcilia o funil com o EVO. Existe porque
    // o EVO não emite evento de mudança de prospect: sem esta varredura,
    // o que o consultor faz dentro do EVO não chega ao painel.
    // 0 desliga.
    syncMinutos: parseInt(env('EVO_SYNC_MINUTOS', '15'), 10),
  },

  // Painel CRM (crm.apacademia.com.br) — login por consultor.
  //
  // Diferente da /teste, que tem senha única: aqui o painel escreve venda
  // em produção no EVO, e sem autor a tabela do funil não sabe dizer quem
  // agendou nem quem vendeu.
  crm: {
    habilitado: env('CRM_HABILITADO', 'true') !== 'false',
    // Sem valor definido, o segredo é sorteado no boot e as sessões caem a
    // cada restart do container.
    sessionSecret: env('CRM_SESSION_SECRET', ''),
    sessaoHoras: parseInt(env('CRM_SESSAO_HORAS', '12'), 10),
    // Secret que o EVO devolve no header do webhook. Sem ele, /webhook/evo
    // é bloqueado (fail-closed) — o endpoint escreve no funil.
    evoWebhookSecret: env('EVO_WEBHOOK_SECRET', ''),
    // URL pública deste serviço, usada para registrar o webhook no EVO.
    urlPublica: env('CRM_URL_PUBLICA', 'https://crm.apacademia.com.br'),
  },

  // Webhook
  webhookSecret: env('WEBHOOK_SECRET', ''),

  // Chave das rotas /admin (leitura de conversas, QR code do WhatsApp).
  // Sem fallback de propósito: se não estiver definida, /admin é bloqueado.
  adminApiKey: env('ADMIN_API_KEY', ''),

  // Página de teste (/teste) — sandbox web para o time conversar com a Leia
  // sem WhatsApp. Senha única, sem usuário: é sala de teste, não painel.
  //
  // Os tetos existem porque a página fica exposta por IP e cada resposta gasta
  // crédito de API. Ajuste-os no .env se o teste for grande; desligue a página
  // com TESTE_HABILITADO=false quando a rodada de testes terminar.
  teste: {
    habilitada: env('TESTE_HABILITADO', 'true') !== 'false',
    senha: env('TESTE_SENHA', 'Leia'),
    // Sem valor definido, o segredo é sorteado no boot e as sessões caem a
    // cada restart do container.
    sessionSecret: env('TESTE_SESSION_SECRET', ''),
    maxMensagensPorSessao: parseInt(env('TESTE_MAX_MSGS_SESSAO', '80'), 10),
    maxMensagensPorDia: parseInt(env('TESTE_MAX_MSGS_DIA', '800'), 10),
  },

  // API keys dos apps irmãos
  appKeys: {
    aquap: process.env.APP_API_KEY_AQUAP || '',
    pagtos: process.env.APP_API_KEY_PAGTOS || '',
    nfse: process.env.APP_API_KEY_NFSE || '',
  },
};
