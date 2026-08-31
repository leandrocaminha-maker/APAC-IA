-- ============================================================
-- APAC-IA SALES — Etapa "finalizado"
--
-- Rode no SQL Editor do Supabase, ANTES da 010. É IDEMPOTENTE.
--
-- POR QUE ESTE ARQUIVO TEM UMA LINHA SÓ
--
-- O Postgres proíbe USAR um rótulo de enum na mesma transação em que ele
-- foi adicionado ("unsafe use of new value of enum type"). A 010 usa
-- `finalizado` em índice parcial — e índice parcial é justamente onde a
-- proibição morde. Separar em dois arquivos é o que faz as duas rodarem
-- sem truque de `COMMIT` no meio.
--
-- O QUE A ETAPA SIGNIFICA
--
-- É o fim da linha da trilha de RELACIONAMENTO: atendimento que nunca foi
-- venda e terminou. Não é `ganho` nem `perdido` de propósito — os dois
-- entram na conversão, e responder o horário da natação para um aluno não
-- é venda ganha nem venda perdida. Ver a 010 e `src/services/funil.js`.
--
-- A posição no enum é o fim da lista. O código ordena o funil por `stage`
-- contando com a ordem de declaração, e `finalizado` depois de `perdido`
-- mantém as etapas de venda na ordem em que sempre estiveram.
-- ============================================================

ALTER TYPE crm_stage ADD VALUE IF NOT EXISTS 'finalizado';

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve listar 9 etapas, com 'finalizado' por último
-- ────────────────────────────────────────
SELECT enumlabel AS etapa
FROM pg_enum
WHERE enumtypid = 'crm_stage'::regtype
ORDER BY enumsortorder;
