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

  whatsapp: {
    // Intervalo (min) do vigia da sessão. 0 desliga.
    //
    // O container pode estar de pé e a Evolution responder 200 com a sessão
    // morta — foi o que aconteceu em 28/08/2026, e ficou 2h30 sem ninguém
    // notar, com a ENTRADA parada junto. Dois minutos é barato: uma
    // chamada local a cada sondagem, sem token nenhum.
    monitorMinutos: parseInt(env('WHATSAPP_MONITOR_MINUTOS', '2'), 10),
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

    // Hosts aceitos no `ApiCallback` que vem dentro do webhook do EVO.
    //
    // Precisa ser lista, e não o host de `baseUrl`: o EVO **chama de volta
    // por outro domínio**. Nós consultamos `evo-integracao-api`, e o
    // webhook manda `evo-integracao` (sem o "-api"). Comparar com o
    // `baseUrl` fazia a guarda anti-SSRF rejeitar TODO callback legítimo —
    // e o sintoma era mudo: a venda chegava, o detalhe nunca era buscado, e
    // o lead simplesmente não fechava como ganho.
    //
    // Continua sendo allowlist, e de propósito não vem do .env: seguir URL
    // arbitrária vinda de webhook é SSRF, e este processo alcança a rede
    // interna do Docker. Ampliar isto é decisão de código, revisada.
    callbackHosts: [
      'evo-integracao-api.w12app.com.br',
      'evo-integracao.w12app.com.br',
    ],

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

  // Campanha ativa de vendas.
  //
  // Aqui a academia é quem começa a conversa, com gente da base do EVO que
  // nunca falou com a Leia. Isso inverte o risco: disparo ativo por
  // WhatsApp não-oficial é o padrão que mais gera bloqueio de número, e o
  // número é um só — o principal da academia.
  //
  // Por isso os dois interruptores abaixo nascem no modo seguro. Ligar a
  // campanha é uma decisão consciente, não um efeito colateral de deploy.
  campanha: {
    // Chave geral. Com false, o worker nem inicia.
    habilitada: env('CAMPANHA_HABILITADA', 'false') === 'true',

    // Ensaio: gera o texto de cada mensagem e grava no alvo, mas NÃO
    // enfileira nada. Serve para ler o que sairia e conferir a distribuição
    // dos horários antes de qualquer coisa chegar a um cliente. Mesmo
    // espírito do EVO_DRY_RUN.
    dryRun: env('CAMPANHA_DRY_RUN', 'true') === 'true',

    // Intervalo do worker que agenda os disparos do dia. 0 desliga.
    minutos: parseInt(env('CAMPANHA_MINUTOS', '10'), 10),

    // Carência entre campanhas, em dias, para quem recebeu e não respondeu.
    //
    // Não responder não é recusa — quem recusa entra em `crm_supressoes`, e
    // isso é permanente. É outra coisa: a pessoa viu e não quis agora, e
    // insistir cedo demais transforma oferta em incômodo. A carência deixa
    // ela voltar a ser público, só que não na semana seguinte.
    //
    // 0 desliga (todo mundo volta a ser elegível assim que a campanha
    // anterior encerra).
    carenciaDias: parseInt(env('CAMPANHA_CARENCIA_DIAS', '30'), 10),
  },

  // Transcrição de áudio recebido no WhatsApp.
  //
  // O Claude não aceita áudio, então isto exige um serviço de fora — não é
  // escolha, é a única via. O Groq foi escolhido por velocidade: transcreve
  // 30s de áudio em 1 a 2 segundos, o que cabe dentro da conversa. A opção
  // local foi medida e descartada (20 a 40s nesta VPS, disputando RAM com
  // o container que atende).
  //
  // SEM a chave, a transcrição fica desligada e o áudio recebe a mesma
  // resposta de sempre: pedir que a pessoa escreva. Nada quebra.
  transcricao: {
    apiKey: env('GROQ_API_KEY', ''),
    modelo: env('GROQ_MODELO_AUDIO', 'whisper-large-v3-turbo'),
    // Teto de tamanho. Áudio muito longo quase sempre é gravação acidental,
    // e é o que mais custa tempo. 8 MB de Opus são ~25 minutos de fala.
    maxBytes: parseInt(env('TRANSCRICAO_MAX_MB', '8'), 10) * 1024 * 1024,
    // Curto de propósito: se passar disto, é melhor pedir texto do que
    // deixar a pessoa esperando sem resposta.
    timeoutMs: parseInt(env('TRANSCRICAO_TIMEOUT_MS', '25000'), 10),
  },

  // Agente — agrupamento de mensagens antes de responder.
  //
  // No WhatsApp ninguém escreve um parágrafo: escreve "oi", "quero saber de
  // natação", "pro meu filho" em três balões seguidos. Sem agrupar, cada
  // balão dispara um turno completo do agente — três vezes o custo do
  // prefixo, e a primeira resposta sai antes de a pessoa terminar de
  // perguntar.
  //
  // `debounceSegundos` é quanto se espera por mais um balão depois do
  // último. `debounceTetoSegundos` é o tempo máximo que a primeira mensagem
  // pode ficar esperando — sem ele, quem digita sem parar nunca é
  // respondido. 0 no debounce desliga o agrupamento.
  agente: {
    debounceSegundos: parseInt(env('AGENTE_DEBOUNCE_SEGUNDOS', '12'), 10),
    debounceTetoSegundos: parseInt(env('AGENTE_DEBOUNCE_TETO_SEGUNDOS', '45'), 10),
  },

  // Follow-up de venda — a régua que recupera quem some.
  //
  // O agente só roda quando chega mensagem, então sem este worker quem
  // para de responder some em silêncio: não existe turno em que o modelo
  // possa agir. Todo envio respeita a janela de contato: 9h–20h30 em dia
  // útil, 9h–13h no sábado, e nada no domingo.
  followup: {
    // Ciclo da FILA (o que já venceu). Não custa token nenhum: é só
    // Postgres. O que ele compra é pontualidade — o `ae_lembrete_24h` sai
    // com o atraso de até um ciclo, e a reconsulta de presença também. Por
    // isso 10 min, e não 60.
    minutos: parseInt(env('FOLLOWUP_MINUTOS', '10'), 10),

    // Régua de lead que parou de responder.
    //
    // Separada do ciclo da fila porque é uma VARREDURA, não uma leitura de
    // fila: percorre os leads vivos da janela e olha a última mensagem de
    // cada um. Silêncio de dois dias não muda de minuto em minuto, então
    // rodar isso a cada 10 min seria pagar o scan 6x por nada.
    silencio: {
      habilitado: env('FOLLOWUP_SILENCIO_HABILITADO', 'true') !== 'false',

      // Intervalo próprio da varredura, em minutos. 0 desliga.
      minutos: parseInt(env('FOLLOWUP_SILENCIO_MINUTOS', '60'), 10),

      // Dias de silêncio para a 1ª cutucada. A 2ª sai 2 dias depois dela —
      // ou seja, no 4º dia de silêncio.
      dias: parseInt(env('FOLLOWUP_SILENCIO_DIAS', '2'), 10),

      // Piso da varredura: quão para trás ela enxerga.
      //
      // Sem piso, a primeira execução acordaria todo lead parado desde
      // sempre — inclusive gente de meses atrás, para quem uma retomada não
      // é retomada, é abordagem fria. 7 dias = "os leads desta semana".
      janelaDias: parseInt(env('FOLLOWUP_SILENCIO_JANELA_DIAS', '7'), 10),

      // Teto de agendamentos por varredura. Segura o susto do primeiro
      // ciclo depois do deploy, quando o acúmulo da semana inteira está
      // elegível de uma vez.
      lote: parseInt(env('FOLLOWUP_SILENCIO_LOTE', '15'), 10),

      // Espaçamento entre os agendamentos de uma mesma varredura, em
      // minutos. 15 mensagens saindo no mesmo minuto é o que denuncia
      // robô — e satura a instância da Evolution.
      intervaloMin: parseInt(env('FOLLOWUP_SILENCIO_INTERVALO_MIN', '7'), 10),
    },
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

    // Assina a resposta do painel com o primeiro nome do consultor.
    //
    // O aparelho já faz isso — as mensagens digitadas no celular chegam
    // como "*Shirlei:*". Pelo painel não chegavam, e o cliente via a mesma
    // conversa ora assinada ora não, sem saber se falava com pessoa ou com
    // a Leia. Numa conversa que passa por bot, consultor no painel e
    // consultor no celular, saber quem está do outro lado não é detalhe.
    assinarResposta: env('CRM_ASSINAR_RESPOSTA', 'true') !== 'false',
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
