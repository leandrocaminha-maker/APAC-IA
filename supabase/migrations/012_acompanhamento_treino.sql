-- ============================================================
-- APAC-IA SALES — Acompanhamento: o treino de musculação do EVO
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- O QUE É
--
-- A régua do acompanhamento passa a ler o treino de musculação de cada
-- aluno no EVO (GET /api/v2/workout/default-client-workout, uma chamada por
-- aluno por dia — D8 do PLANO_ACOMPANHAMENTO.md do Prescrev): início,
-- validade, sessões previstas e marcadas no app, professor que prescreveu.
-- Com ele vêm ciclo em risco, mínimo cumprido, "não marca no app" e o
-- aviso de treino vencendo.
--
--   acomp_treinos             a última leitura dos treinos de cada aluno.
--                             Se o EVO não responder no dia, a régua usa ela.
--   acomp_disparos.avisos_equipe
--                             o que iria à equipe naquele dia (treino
--                             vencendo), separado da mensagem ao aluno: aviso
--                             ao professor não ocupa a mensagem do dia. Quem
--                             manda é o briefing (etapa A4).
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_treinos (
  cliente_id     UUID PRIMARY KEY,           -- prescrev.clients.id
  evo_member_id  INTEGER NOT NULL,
  treinos        JSONB NOT NULL DEFAULT '[]',-- os treinos não excluídos, resumidos
  lido_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE acomp_treinos IS
  'Última leitura dos treinos de musculação do aluno no EVO (default-client-workout), resumida. '
  'A régua usa quando o EVO não responde no dia.';

ALTER TABLE acomp_disparos
  ADD COLUMN IF NOT EXISTS avisos_equipe TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN acomp_disparos.avisos_equipe IS
  'O que iria à equipe neste dia (treino vencendo), à parte da mensagem ao aluno. Quem manda é o briefing (A4).';

ALTER TABLE acomp_treinos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_treinos TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — 1 linha, rls_habilitado = true; e a coluna nova
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'acomp_treinos';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'acomp_disparos' AND column_name = 'avisos_equipe';
