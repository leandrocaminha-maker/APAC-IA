-- ============================================================
-- APAC-IA SALES — a carteira de treinos de musculação
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- 11/11/2026, pedido do responsável. O Prescrev mostra ao professor e à
-- coordenação os alunos ATIVOS com treino de musculação no EVO — status,
-- vencimento, realizados e previstos —, para o professor saber com
-- antecedência quem vai precisar de treino novo e trazer o aluno ao Prescrev
-- antes de renovar a prescrição.
--
-- QUEM É DA CARTEIRA diz o EVO: uma segmentação do CRM ("alunos ativos com
-- treino"), que uma automação atualiza e manda ao webhook, um POST por pessoa
-- (`crm.segmentation.batch`). Ela chega SEM a descrição da comunicação, e é
-- isso que a separa da coorte de campanha (`absorverSegmentacao`, que exige a
-- descrição). Em 11/11/2026 chegaram 337 alunos.
--
-- O TREINO não vem no evento: o worker lê `default-client-workout` de cada
-- um, uma vez por dia, e guarda o resumo de `resumirTreinos` (regua.js) — o
-- mesmo que a régua do acompanhamento lê.
--
--   segmentado_em   a última vez que a segmentação trouxe a pessoa
--   treinos         os treinos resumidos, inclusive os vencidos
--   lido_em         a última leitura do EVO (nulo = ainda não lido)
--   erro            o erro da última leitura, se houve
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_carteira_treinos (
  id_member       INTEGER PRIMARY KEY,
  nome            TEXT,
  plano           TEXT,
  status_evo      TEXT,
  segmentado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  treinos         JSONB NOT NULL DEFAULT '[]',
  lido_em         TIMESTAMPTZ,
  erro            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carteira_treinos_lido ON acomp_carteira_treinos (lido_em NULLS FIRST);

COMMENT ON TABLE acomp_carteira_treinos IS
  'Alunos ativos com treino de musculação no EVO (segmentação do CRM) e o resumo dos treinos deles, '
  'lido uma vez por dia. O Prescrev lê pela rota assinada /acompanhamento/carteira-treinos.';

ALTER TABLE acomp_carteira_treinos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_carteira_treinos TO service_role;
