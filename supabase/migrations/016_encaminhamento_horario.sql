-- ============================================================
-- APAC-IA SALES — encaminhamento só no horário de trabalho
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE. Aplicar ANTES do deploy:
-- o código novo grava `na_fila` e `enviar_em`.
--
-- Decisão do responsável em 08/10/2026: mensagem à equipe só sai no
-- horário de trabalho de quem recebe (cadastrado no Prescrev, migration
-- 043 de lá). Fora dele, o encaminhamento fica NA FILA e sai em
-- `enviar_em`, o começo do próximo turno; o worker o solta a cada
-- ACOMPANHAMENTO_ENCAMINHAMENTOS_MINUTOS.
--
-- Nos `simulado` (ensaio), `enviar_em` é quando sairia — a prévia mostra a
-- regra do horário sem mandar nada.
-- ============================================================

ALTER TABLE acomp_encaminhamentos ADD COLUMN IF NOT EXISTS enviar_em TIMESTAMPTZ;

ALTER TABLE acomp_encaminhamentos DROP CONSTRAINT IF EXISTS acomp_encaminhamentos_status_check;
ALTER TABLE acomp_encaminhamentos ADD CONSTRAINT acomp_encaminhamentos_status_check CHECK (status IN
  ('simulado', 'na_fila', 'aguardando', 'assumido', 'resolvido', 'sem_destino', 'cancelado'));

CREATE INDEX IF NOT EXISTS idx_acomp_encaminhamento_fila
  ON acomp_encaminhamentos (enviar_em) WHERE status = 'na_fila';

NOTIFY pgrst, 'reload schema';

-- Conferência — 1 linha, com 'na_fila' no CHECK
SELECT conname, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint WHERE conname = 'acomp_encaminhamentos_status_check';
