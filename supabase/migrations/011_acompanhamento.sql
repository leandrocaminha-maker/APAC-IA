-- ============================================================
-- APAC-IA SALES — Acompanhamento automatizado: a régua em ensaio
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- O QUE É
--
-- O acompanhamento dos alunos que fizeram avaliação no Prescrev
-- (PLANO_ACOMPANHAMENTO.md, no repositório do Prescrev). O Prescrev publica
-- a FICHA de cada aluno — trilha, cadência, frequência, o que o aluno leu
-- no relatório — e os MODELOS de mensagem; a régua roda aqui, porque aqui
-- moram o número, a janela, o teto e a Leia (decisão D1).
--
-- Esta migration é a da etapa A2: a régua em ENSAIO. Ela decide, todo dia,
-- o que sairia para cada aluno e por quê, e grava. Não envia nada — não há
-- caminho daqui até a Evolution nesta etapa.
--
--   acomp_fichas     cópia da última ficha recebida do Prescrev. Se o
--                    Prescrev cair, a régua roda sobre a cópia.
--   acomp_disparos   uma linha por aluno, por dia, por modo: o que sairia
--                    (simulado), o que estava devido e não saiu (bloqueado)
--                    ou que nada estava devido (nada) — sempre com o motivo.
--                    No ensaio, as linhas "simulado" fazem o relógio da
--                    cadência andar, como se tivessem saído.
--
-- A ativação, os encaminhamentos e a equipe entram nas migrations das
-- etapas seguintes, junto com o código que os grava.
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_fichas (
  cliente_id     UUID PRIMARY KEY,           -- prescrev.clients.id
  ficha          JSONB NOT NULL,
  atualizada_em  TIMESTAMPTZ,                -- a da ficha, no Prescrev
  recebida_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE acomp_fichas IS
  'Cópia da ficha do acompanhamento publicada pelo Prescrev (/api/acompanhamento/fichas). '
  'A régua roda sobre ela quando o Prescrev não responde.';

CREATE TABLE IF NOT EXISTS acomp_disparos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id     UUID NOT NULL,
  dia            DATE NOT NULL,              -- o dia em São Paulo
  modo           TEXT NOT NULL CHECK (modo IN ('ensaio', 'envio')),
  status         TEXT NOT NULL CHECK (status IN
                   ('simulado', 'bloqueado', 'nada', 'pendente', 'enviado', 'cancelado', 'falhou')),
  situacao       TEXT,                       -- rotina, boas_vindas, reavaliacao, ausencia, retorno
  trilha         TEXT,
  modelo_id      TEXT,                       -- id estável do modelo no Prescrev
  texto          TEXT,                       -- a mensagem já preenchida
  valores        JSONB NOT NULL DEFAULT '{}',-- o valor de cada marcador
  motivo         TEXT NOT NULL,              -- por que esta situação, ou por que nada
  bloqueios      TEXT[] NOT NULL DEFAULT '{}',
  previsto_para  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Uma mensagem automática por aluno por dia (§5.4 do plano). Rodar o
  -- ensaio de novo no mesmo dia refaz a linha, não acrescenta outra.
  CONSTRAINT uq_acomp_disparo_dia UNIQUE (cliente_id, dia, modo)
);

COMMENT ON TABLE acomp_disparos IS
  'Régua do acompanhamento: uma linha por aluno, dia e modo, com a situação, o modelo, o texto, '
  'os valores dos marcadores e o motivo. No ensaio, "simulado" é o que sairia.';

CREATE INDEX IF NOT EXISTS idx_acomp_disparos_dia ON acomp_disparos (dia DESC);

DROP TRIGGER IF EXISTS trg_acomp_disparos_updated ON acomp_disparos;
CREATE TRIGGER trg_acomp_disparos_updated
  BEFORE UPDATE ON acomp_disparos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE acomp_fichas ENABLE ROW LEVEL SECURITY;
ALTER TABLE acomp_disparos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_fichas TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_disparos TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — 2 linhas, rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('acomp_fichas', 'acomp_disparos');
