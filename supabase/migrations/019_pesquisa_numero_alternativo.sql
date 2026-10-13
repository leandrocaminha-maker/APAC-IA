-- ============================================================
-- APAC-IA SALES — pesquisa de satisfação pelo número alternativo
--
-- Rode no SQL Editor do Supabase, DEPOIS da 006. É IDEMPOTENTE. Aplicar
-- ANTES de pôr EVOLUTION_INSTANCE_ALT no `.env`: sem a variável o código
-- novo não lê nada daqui; com ela e sem esta migration, o teto do número
-- alternativo não consegue contar e nada sai por ele (falha fechada).
--
-- ⚠️ Auto-expose está DESLIGADO: sem os GRANTs a API responde PGRST205 e
-- parece migration não aplicada.
--
-- Pedido do responsável em 12/10/2026: uma pesquisa de satisfação para os
-- alunos adultos, saindo por um SEGUNDO número da academia. O público vem do
-- EVO, pela mesma segmentação das campanhas (`crm.segmentation.batch`).
--
-- O QUE MUDA
--
-- crm_campanhas     ganha a finalidade ('venda' | 'pesquisa') e os textos da
--                   pesquisa. Pesquisa sai pelo número alternativo, sempre.
-- wa_alt_mensagens  o livro do número alternativo: o que saiu e o que chegou
--                   por ele. NÃO é `wa_messages`, e de propósito — lá está o
--                   atendimento do número principal, e é de lá que saem o
--                   teto do número, o painel, o follow-up e o histórico que
--                   a Leia lê. Misturar poria a pesquisa em tudo isso.
-- ============================================================

-- ────────────────────────────────────────
-- Campanha: a finalidade e os textos da pesquisa
-- ────────────────────────────────────────

ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS finalidade TEXT NOT NULL DEFAULT 'venda';

DO $$ BEGIN
  ALTER TABLE crm_campanhas
    ADD CONSTRAINT crm_campanhas_finalidade_check CHECK (finalidade IN ('venda', 'pesquisa'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A primeira mensagem: a que dá credibilidade ao número novo. Escrita por
-- uma pessoa — nenhum texto da pesquisa passa pelo modelo. `---` sozinho
-- numa linha separa as redações; cada alvo recebe uma. Marcadores: {nome} e
-- {numero_principal}. Não leva link.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS mensagem_abertura TEXT;

-- A segunda mensagem, com o marcador {link}.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS mensagem_link TEXT;

-- O endereço da pesquisa.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS link TEXT;

-- Quando o link vai para quem NÃO respondeu à abertura:
--   NULL  nunca — só recebe o link quem respondeu
--   N     N minutos depois da abertura, mesmo sem resposta
-- Quem responde recebe na hora, nos dois casos.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS link_espera_min INT;

COMMENT ON COLUMN crm_campanhas.finalidade IS
  'venda: sai pelo número principal, texto do modelo, porta de consentimento. '
  'pesquisa: sai pelo número alternativo, texto fixo, link depois da resposta.';

-- ────────────────────────────────────────
-- O livro do número alternativo
--
--   tipo = 'abertura'  abriu a conversa: é o que CONTA no teto do dia
--          'link'      o link da pesquisa
--          'auto'      resposta fixa (esclarecimento, agradecimento, aviso)
--          'recebida'  o que a pessoa escreveu
--
-- `instancia` é o nome da instância na Evolution. A rampa de aquecimento
-- conta os dias desde a primeira abertura DELA: chip novo com instância nova
-- recomeça a rampa, e o histórico do número antigo continua aqui.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_alt_mensagens (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instancia        TEXT NOT NULL,
  phone            TEXT NOT NULL,                 -- normalizado, com DDI
  direction        message_direction NOT NULL,
  tipo             TEXT NOT NULL CHECK (tipo IN ('abertura', 'link', 'auto', 'recebida')),
  origem           TEXT,                          -- 'alt:campanha:<slug>', 'alt:link:<slug>', 'alt:auto'
  content          TEXT NOT NULL,
  status           message_status DEFAULT 'sent', -- entregue e lida chegam pelo webhook
  evolution_msg_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A contagem do teto: aberturas da instância, de hoje.
CREATE INDEX IF NOT EXISTS idx_wa_alt_teto ON wa_alt_mensagens (instancia, tipo, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_alt_phone ON wa_alt_mensagens (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_alt_evo_id ON wa_alt_mensagens (evolution_msg_id);

COMMENT ON TABLE wa_alt_mensagens IS
  'O que saiu e o que chegou pelo número alternativo (pesquisas). Separado de wa_messages: '
  'nada daqui entra no teto, no painel, no follow-up nem no histórico do número principal.';

-- ────────────────────────────────────────
-- A view, com a finalidade e as etapas da pesquisa
--
-- DROP antes do CREATE pelo motivo da 006: `CREATE OR REPLACE` só aceita
-- acrescentar coluna no fim. O GRANT é refeito porque o DROP o leva junto.
--
-- `suprimidos` segue sendo o que a guarda automática lê. Na pesquisa, quem
-- responde SAIR ao número alternativo vira `suprimido` nesta campanha — e
-- só nela: a lista geral (`crm_supressoes`) é de quem pediu ao número
-- principal, e vale para tudo.
-- ────────────────────────────────────────
DROP VIEW IF EXISTS crm_campanhas_resumo;

CREATE VIEW crm_campanhas_resumo AS
SELECT
  c.id, c.slug, c.titulo, c.tipo, c.finalidade, c.status, c.teto_diario,
  COUNT(a.id)                                                   AS alvos,
  COUNT(*) FILTER (WHERE a.status = 'pendente')                 AS pendentes,
  COUNT(*) FILTER (WHERE a.status = 'agendado')                 AS agendados,
  COUNT(*) FILTER (WHERE a.status = 'enviado')                  AS enviados,
  COUNT(*) FILTER (WHERE a.status = 'respondeu')                AS responderam,
  COUNT(*) FILTER (WHERE a.status = 'suprimido')                AS suprimidos,
  COUNT(*) FILTER (WHERE a.status = 'erro')                     AS erros,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'aceitou')          AS aceitaram,
  COUNT(*) FILTER (WHERE a.etapa_conversa IN ('recusou', 'pesquisa_recusou'))
                                                                AS recusaram,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'conversando')      AS conversando,
  -- Pesquisa: quem tem o link na mão, e quem ainda não respondeu à abertura.
  COUNT(*) FILTER (WHERE a.etapa_conversa IN ('pesquisa_link', 'pesquisa_encerrada'))
                                                                AS links_enviados,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'pesquisa_aguardando' AND a.status = 'enviado')
                                                                AS sem_resposta,
  COUNT(*) FILTER (WHERE a.sent_at::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
                                                                AS enviados_hoje,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'respondeu')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu')), 0), 3
  )                                                             AS taxa_resposta,
  ROUND(
    COUNT(*) FILTER (WHERE a.etapa_conversa = 'aceitou')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.etapa_conversa IN ('aceitou','recusou','conversando')), 0), 3
  )                                                             AS taxa_aceite,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'suprimido')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu', 'suprimido')), 0), 3
  )                                                             AS taxa_supressao,
  c.limiar_supressao, c.pausada_motivo, c.created_at
FROM crm_campanhas c
LEFT JOIN crm_campanha_alvos a ON a.campanha_id = c.id
GROUP BY c.id
ORDER BY c.created_at DESC;

GRANT SELECT ON crm_campanhas_resumo TO service_role;

-- ────────────────────────────────────────
-- RLS e privilégios
-- ────────────────────────────────────────
ALTER TABLE wa_alt_mensagens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON wa_alt_mensagens TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — a tabela com rls_habilitado = true, e as 5 colunas novas
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wa_alt_mensagens';

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'crm_campanhas'
  AND column_name IN ('finalidade', 'mensagem_abertura', 'mensagem_link', 'link', 'link_espera_min')
ORDER BY column_name;
