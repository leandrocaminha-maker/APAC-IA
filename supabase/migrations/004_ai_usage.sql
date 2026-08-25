-- ============================================================
-- APAC-IA SALES — Telemetria de consumo da API da Anthropic
--
-- Rode no SQL Editor do Supabase, DEPOIS da 003. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose de tabelas está DESLIGADO neste projeto: sem o GRANT
-- do bloco final a API responde PGRST205 e parece migration não aplicada.
--
-- POR QUE ESTA TABELA EXISTE
--
-- Até 24/08/2026 o consumo só aparecia num `logger.debug` que rodava uma
-- única vez por turno, no `return` final do agente. Duas consequências:
--
-- 1. As idas e voltas de tool não eram contadas. Um turno que chama
--    `buscar_cadastro` → `cadastrar_prospect` → `agendar` são 4 chamadas
--    à API e só a última aparecia — ou seja, o número no log era o mais
--    otimista possível.
-- 2. Log não se agrega. Não dava para responder "quanto custou a conversa
--    do lead 412?" nem "qual a taxa de acerto de cache hoje?".
--
-- Uma linha por CHAMADA à API, não por turno.
-- ============================================================

CREATE TABLE IF NOT EXISTS wa_ai_usage (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT REFERENCES wa_conversations(id) ON DELETE SET NULL,

  -- De onde veio a chamada: 'webhook' (WhatsApp), 'teste' (página /teste),
  -- 'crm' (simulador do painel), 'followup' (worker de retomada).
  origem          TEXT NOT NULL DEFAULT 'webhook',

  modelo          TEXT NOT NULL,

  -- Qual volta do loop de tools. 0 = primeira chamada do turno.
  iteracao        SMALLINT NOT NULL DEFAULT 0,

  -- Módulos da base carregados nesta chamada. É o que explica por que duas
  -- chamadas do mesmo turno têm prefixos de tamanhos diferentes.
  modulos         TEXT[] DEFAULT '{}',

  -- Os quatro números que a API devolve em `usage`. O tamanho total do
  -- prompt é a SOMA dos três de entrada, não `input_tokens` sozinho —
  -- `input_tokens` é só o resto que não passou pelo cache.
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,

  -- Custo em dólar calculado no momento da chamada, com a tabela de preços
  -- vigente. Gravado (e não calculado depois) de propósito: preço muda, e
  -- recalcular o passado com o preço de hoje falsearia o histórico.
  custo_usd       NUMERIC(10, 6) NOT NULL DEFAULT 0,

  stop_reason     TEXT,
  duracao_ms      INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_created ON wa_ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_conv ON wa_ai_usage (conversation_id);
CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_origem ON wa_ai_usage (origem, created_at DESC);

-- ────────────────────────────────────────
-- Visão diária — é o que se olha no dia a dia
--
-- `taxa_cache` é a fração dos tokens de entrada que veio do cache barato.
-- Perto de 1 = o prefixo está sendo reaproveitado. Perto de 0 com
-- `tokens_cache_escrita` alto = o cache está expirando entre as conversas,
-- e nesse caso ele está ENCARECENDO o sistema: escrever custa 1,25x (TTL de
-- 5 min) ou 2x (TTL de 1h) o preço de entrada, contra 1x de não ter cache.
-- ────────────────────────────────────────
CREATE OR REPLACE VIEW wa_ai_usage_diario AS
SELECT
  (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  origem,
  COUNT(*)                          AS chamadas,
  COUNT(DISTINCT conversation_id)   AS conversas,
  SUM(input_tokens)                 AS tokens_sem_cache,
  SUM(cache_creation_tokens)        AS tokens_cache_escrita,
  SUM(cache_read_tokens)            AS tokens_cache_leitura,
  SUM(output_tokens)                AS tokens_saida,
  ROUND(
    SUM(cache_read_tokens)::numeric
    / NULLIF(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0),
    3
  )                                 AS taxa_cache,
  ROUND(SUM(custo_usd), 4)          AS custo_usd,
  ROUND(SUM(custo_usd) / NULLIF(COUNT(DISTINCT conversation_id), 0), 4)
                                    AS custo_por_conversa_usd
FROM wa_ai_usage
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ────────────────────────────────────────
-- RLS e privilégios
-- ────────────────────────────────────────
ALTER TABLE wa_ai_usage ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON wa_ai_usage TO service_role;
GRANT SELECT ON wa_ai_usage_diario TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve retornar 1 linha, com rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'wa_ai_usage';
