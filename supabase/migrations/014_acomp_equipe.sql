-- ============================================================
-- APAC-IA SALES — a equipe do acompanhamento
--
-- Rode no SQL Editor do Supabase, DEPOIS da 013. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- O número de WhatsApp de cada professor e coordenador que ativou o código
-- EQUIPE (§7.2 do PLANO_ACOMPANHAMENTO.md do Prescrev, D4). O código vem do
-- Prescrev (/api/acompanhamento/equipe); o número é o de quem mandou — é o
-- que prova que ele é da pessoa, e que a conversa foi aberta por ela.
--
-- Uma pessoa, um número: ativar de outro aparelho troca o anterior.
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_equipe (
  phone        TEXT PRIMARY KEY,
  profile_id   UUID NOT NULL,              -- public.profiles.id, no Prescrev
  nome         TEXT NOT NULL,              -- primeiro nome
  papel        TEXT NOT NULL,              -- professor, coordinator, master
  codigo       TEXT NOT NULL,              -- o código usado na ativação
  ativado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_equipe_profile ON acomp_equipe (profile_id);

COMMENT ON TABLE acomp_equipe IS
  'Número de WhatsApp de cada pessoa da equipe que ativou o código EQUIPE do Prescrev. '
  'Recebe os encaminhamentos do acompanhamento. Uma pessoa, um número.';

ALTER TABLE acomp_equipe ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_equipe TO service_role;

NOTIFY pgrst, 'reload schema';

-- Conferência — 1 linha, rls_habilitado = true
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'acomp_equipe';
