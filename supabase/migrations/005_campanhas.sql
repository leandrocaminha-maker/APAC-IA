-- ============================================================
-- APAC-IA SALES — Campanha ativa de vendas
--
-- Rode no SQL Editor do Supabase, DEPOIS da 004. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose de tabelas está DESLIGADO neste projeto: sem o GRANT
-- do bloco final a API responde PGRST205 e parece migration não aplicada.
--
-- O QUE ISTO ADICIONA
--
-- Até aqui o sistema era inteiramente reativo: todo lead de crm_leads tem
-- source 'whatsapp', ou seja, escreveu primeiro. A campanha inverte o
-- sentido — é a academia que começa a conversa, com gente da base do EVO
-- que nunca falou com a Leia.
--
-- Isso muda o risco. Disparo ativo por WhatsApp não-oficial é o padrão que
-- mais gera bloqueio de número, e hoje o número é um só: o principal da
-- academia. Por isso três das quatro tabelas aqui existem para FREAR, não
-- para disparar — supressão, teto e contabilidade por alvo.
-- ============================================================

-- ────────────────────────────────────────
-- Tipos
-- ────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE campanha_tipo AS ENUM (
    'lote',    -- coorte montada de uma vez, diluída ao longo dos dias
    'gatilho'  -- pessoa entra uma a uma, a partir de evento do EVO
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campanha_status AS ENUM (
    'rascunho',  -- criada, alvos ainda não montados
    'ativa',     -- o worker pode disparar
    'pausada',   -- parada (por pessoa ou pela guarda automática)
    'concluida'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campanha_alvo_status AS ENUM (
    'pendente',   -- ainda não teve mensagem gerada
    'agendado',   -- texto gerado e enfileirado em wa_message_queue
    'enviado',    -- saiu de verdade
    'respondeu',  -- a pessoa respondeu; vira conversa normal e a campanha para
    'suprimido',  -- pediu para sair, ou já estava na lista de supressão
    'erro'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ────────────────────────────────────────
-- 1. Supressão — a lista de quem NÃO pode receber
--
-- Vem primeiro de propósito: é a tabela que toda a régua consulta, campanha
-- ou follow-up. Um "pare de me mandar mensagem" tem que valer para tudo que
-- sai daqui, não só para a campanha em que a pessoa estava.
--
-- A chave é o telefone e não o contato: quem pede para sair pode nem ter
-- linha em wa_contacts ainda, e o pedido precisa valer mesmo assim.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_supressoes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,           -- normalizado com DDI: 5511999999999
  motivo      TEXT NOT NULL,                  -- 'pediu_para_sair', 'reclamacao', 'manual'
  origem      TEXT,                           -- 'whatsapp', 'painel', 'importacao'
  detalhe     TEXT,                           -- a frase que a pessoa escreveu, quando houver
  campanha_id BIGINT,                         -- em qual campanha ela estava, se estava
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_supressoes_phone ON crm_supressoes (phone);

-- ────────────────────────────────────────
-- 2. Campanhas
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_campanhas (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  titulo        TEXT NOT NULL,
  tipo          campanha_tipo NOT NULL DEFAULT 'lote',
  status        campanha_status NOT NULL DEFAULT 'rascunho',

  -- Qual coorte montar. Ver src/services/segmentos.js.
  segmento      TEXT NOT NULL,
  segmento_args JSONB DEFAULT '{}',

  -- A OFERTA É ESCRITA POR UMA PESSOA e o modelo só a embrulha.
  -- Sem base de conhecimento carregada, ele não tem como conferir preço,
  -- horário ou regra — então nada disso pode nascer dele. O que estiver
  -- aqui é o único fato que a mensagem pode afirmar.
  oferta        TEXT NOT NULL,

  -- Instrução de condução (tom, ângulo, o que perguntar no fim).
  roteiro       TEXT,

  -- Freio principal. 20 é o valor de piloto: cabe num dia de janela com
  -- ~34 minutos entre mensagens, que é cadência de gente, não de robô.
  teto_diario   INT NOT NULL DEFAULT 20,

  -- Guarda automática: acima desta fração de supressão a campanha se pausa
  -- sozinha. É a realimentação que protege o número — sem ela, descobrir
  -- que a lista estava errada custaria o bloqueio.
  limiar_supressao NUMERIC(4,3) NOT NULL DEFAULT 0.030,

  -- Só avalia o limiar depois deste tanto de envio; senão a primeira
  -- supressão de uma campanha de 3 mensagens pausaria tudo.
  minimo_para_avaliar INT NOT NULL DEFAULT 30,

  pausada_motivo TEXT,
  criada_por    TEXT,
  base_legal    TEXT,                          -- LGPD: por que se pode falar com essa lista
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_campanhas_status ON crm_campanhas (status);

-- ────────────────────────────────────────
-- 3. Alvos — uma linha por pessoa por campanha
--
-- É o livro-razão da campanha. wa_message_queue é transporte: a linha de lá
-- some depois de enviada, esta fica.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_campanha_alvos (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campanha_id   BIGINT NOT NULL REFERENCES crm_campanhas(id) ON DELETE CASCADE,
  contact_id    BIGINT REFERENCES wa_contacts(id) ON DELETE SET NULL,

  phone         TEXT NOT NULL,                 -- normalizado, com DDI
  nome          TEXT,
  evo_id_member BIGINT,
  evo_id_prospect BIGINT,

  status        campanha_alvo_status NOT NULL DEFAULT 'pendente',

  -- Por que esta pessoa entrou na coorte (meses inativo, modalidade, etc.).
  -- Vai para o gerador de texto: é o que permite a mensagem falar do caso
  -- dela em vez de repetir o mesmo parágrafo para todo mundo.
  contexto      JSONB DEFAULT '{}',

  mensagem      TEXT,                          -- o texto gerado, guardado como foi enviado
  queue_id      BIGINT,                        -- linha em wa_message_queue, enquanto pendente
  scheduled_for TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  erro          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Uma pessoa não entra duas vezes na mesma campanha. Sem isto, remontar a
-- coorte (ou um gatilho disparando de novo) mandaria a mesma mensagem
-- outra vez — que é exatamente o que faz alguém denunciar o número.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_campanha_alvos_pessoa
  ON crm_campanha_alvos (campanha_id, phone);

CREATE INDEX IF NOT EXISTS idx_crm_alvos_campanha_status
  ON crm_campanha_alvos (campanha_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_alvos_phone ON crm_campanha_alvos (phone);
-- Usado para marcar 'respondeu' quando chega mensagem de entrada.
CREATE INDEX IF NOT EXISTS idx_crm_alvos_phone_status
  ON crm_campanha_alvos (phone, status);

-- ────────────────────────────────────────
-- Gatilhos de updated_at (a função vem da 002)
-- ────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_crm_campanhas_updated ON crm_campanhas;
CREATE TRIGGER trg_crm_campanhas_updated
  BEFORE UPDATE ON crm_campanhas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_crm_campanha_alvos_updated ON crm_campanha_alvos;
CREATE TRIGGER trg_crm_campanha_alvos_updated
  BEFORE UPDATE ON crm_campanha_alvos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────
-- Visão de acompanhamento — é o que se olha durante o piloto
--
-- `taxa_supressao` é o número que decide se a campanha continua. Ela é
-- comparada com `limiar_supressao` pela guarda automática, e é a mesma
-- conta que uma pessoa faria no olho.
-- ────────────────────────────────────────
CREATE OR REPLACE VIEW crm_campanhas_resumo AS
SELECT
  c.id,
  c.slug,
  c.titulo,
  c.tipo,
  c.status,
  c.teto_diario,
  COUNT(a.id)                                                   AS alvos,
  COUNT(*) FILTER (WHERE a.status = 'pendente')                 AS pendentes,
  COUNT(*) FILTER (WHERE a.status = 'agendado')                 AS agendados,
  COUNT(*) FILTER (WHERE a.status = 'enviado')                  AS enviados,
  COUNT(*) FILTER (WHERE a.status = 'respondeu')                AS responderam,
  COUNT(*) FILTER (WHERE a.status = 'suprimido')                AS suprimidos,
  COUNT(*) FILTER (WHERE a.status = 'erro')                     AS erros,
  COUNT(*) FILTER (WHERE a.sent_at::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
                                                                AS enviados_hoje,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'respondeu')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu')), 0), 3
  )                                                             AS taxa_resposta,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'suprimido')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu', 'suprimido')), 0), 3
  )                                                             AS taxa_supressao,
  c.limiar_supressao,
  c.pausada_motivo,
  c.created_at
FROM crm_campanhas c
LEFT JOIN crm_campanha_alvos a ON a.campanha_id = c.id
GROUP BY c.id
ORDER BY c.created_at DESC;

-- ────────────────────────────────────────
-- RLS e privilégios
-- ────────────────────────────────────────
ALTER TABLE crm_supressoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_campanhas ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_campanha_alvos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_supressoes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_campanhas TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_campanha_alvos TO service_role;
GRANT SELECT ON crm_campanhas_resumo TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve retornar 3 linhas, todas com rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('crm_supressoes', 'crm_campanhas', 'crm_campanha_alvos')
ORDER BY tablename;
