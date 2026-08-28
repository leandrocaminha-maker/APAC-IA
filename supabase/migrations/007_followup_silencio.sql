-- ============================================================
-- APAC-IA SALES — Follow-up de lead que parou de responder
--
-- Rode no SQL Editor do Supabase, DEPOIS da 003. É IDEMPOTENTE.
--
-- ⚠️ Não cria tabela nova: reaproveita `crm_followups` inteira. Por isso
-- não há GRANT aqui — o da 003 já cobre.
--
-- POR QUE UM TIPO NOVO, E NÃO `sondagem_1`/`sondagem_2`
--
-- As sondagens são a régua de DEPOIS DA AULA: `proximaSondagem()` as trata
-- como um orçamento de duas rodadas que nasce do `ae_pos_aula`, e o roteiro
-- delas afirma que "a pessoa passou pela experiência". Reaproveitar os
-- mesmos tipos para o silêncio traria dois defeitos:
--
--  1. O índice único parcial é `(lead_id, tipo) WHERE pendente`. Um lead que
--     sumisse antes da aula e depois marcasse a experimental colidiria com a
--     própria régua pós-aula — e gastaria as duas rodadas dela antes da aula
--     acontecer.
--  2. O roteiro mentiria. Um lead em `em_conversa` que nunca pisou na
--     academia receberia "você passou pela experiência e ainda não fechou".
--
-- Com tipos próprios as duas réguas ficam disjuntas por construção:
-- `sondagem_*` é o silêncio DEPOIS da aula, `silencio_*` é o silêncio em
-- qualquer outro ponto do funil. O worker recusa abrir uma quando a outra
-- já correu (ver `varrerSilenciosos`).
-- ============================================================

-- ────────────────────────────────────────
-- Tipos novos
--
-- `ADD VALUE IF NOT EXISTS` é idempotente. Só adiciona rótulo: não usa o
-- valor na mesma transação, que é a única coisa que o Postgres proíbe aqui.
--
-- A posição no enum é o fim da lista de propósito — nada no código ordena
-- por `tipo`, só filtra com `IN`, então a ordem é indiferente.
-- ────────────────────────────────────────
ALTER TYPE crm_followup_tipo ADD VALUE IF NOT EXISTS 'silencio_1';
ALTER TYPE crm_followup_tipo ADD VALUE IF NOT EXISTS 'silencio_2';

-- ────────────────────────────────────────
-- Índice da varredura
--
-- `varrerSilenciosos` parte de `crm_leads` filtrando por etapa viva e
-- `last_activity_at` dentro da janela (padrão: 7 dias). O índice
-- `idx_crm_leads_stage` da 002 é `(stage, last_activity_at DESC)` e já
-- serve — este aqui cobre o caso de a varredura rodar sem recorte de etapa,
-- que é o que o endpoint manual faz quando o consultor amplia a janela.
-- ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_crm_leads_atividade
  ON crm_leads (last_activity_at DESC)
  WHERE stage NOT IN ('ganho', 'perdido');

-- A varredura pergunta "qual foi a última mensagem NOSSA neste contato?".
-- Sem isto ela vira seq scan em wa_messages a cada lead candidato.
CREATE INDEX IF NOT EXISTS idx_wa_msg_contact_created
  ON wa_messages (contact_id, created_at DESC);

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve listar os 6 tipos, com silencio_1 e silencio_2
-- ────────────────────────────────────────
SELECT enumlabel AS tipo
FROM pg_enum
WHERE enumtypid = 'crm_followup_tipo'::regtype
ORDER BY enumsortorder;
