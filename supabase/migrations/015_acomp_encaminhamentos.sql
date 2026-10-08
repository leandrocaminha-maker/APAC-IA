-- ============================================================
-- APAC-IA SALES — os encaminhamentos do acompanhamento
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- Quando um aluno precisa do professor, o acompanhamento abre um
-- ENCAMINHAMENTO e avisa o professor no WhatsApp dele (briefing, §7 do
-- PLANO_ACOMPANHAMENTO.md do Prescrev). Ele responde 1 (eu assumo),
-- 2 (já resolvi) ou 3 (não é comigo); sem "1" no prazo, ou com "3", o
-- encaminhamento vai ao coordenador.
--
-- Origem:
--   regua   os avisos à equipe da régua (treino vencendo ou vencido, ciclo em
--           risco e ausência na trilha de adesão)
--   teste   o envio de teste do painel, com aluno fictício
--   leia    o que a Leia encaminhar na conversa com o aluno (etapa A3)
--
-- Situação:
--   simulado     aberto em ensaio, com o texto do briefing, e NÃO enviado —
--                decisão do responsável em 08/10/2026 para a fase de teste
--   aguardando   enviado, esperando o 1/2/3 (nivel: professor ou coordenacao)
--   assumido, resolvido
--   sem_destino  ninguém para receber, ou a coordenação também não assumiu:
--                fica na tela do Prescrev
--   cancelado
--
-- `chave` não deixa abrir duas vezes o mesmo encaminhamento: o treino
-- vencendo aparece todo dia por uma semana, e é um encaminhamento só.
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_encaminhamentos (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chave                    TEXT NOT NULL,
  origem                   TEXT NOT NULL CHECK (origem IN ('regua', 'teste', 'leia')),
  cliente_id               UUID,             -- prescrev.clients.id; nulo no teste
  aluno                    TEXT NOT NULL,    -- primeiro nome
  motivo_codigo            TEXT NOT NULL,
  motivo                   TEXT NOT NULL,
  urgencia                 TEXT NOT NULL CHECK (urgencia IN ('hoje', 'proximos_dias')),
  resumo                   TEXT,
  professor_profile_id     UUID,
  professor_nome           TEXT,
  destino_origem           TEXT,             -- card, treino_evo, avaliador
  nivel                    TEXT NOT NULL DEFAULT 'professor' CHECK (nivel IN ('professor', 'coordenacao')),
  destinatario_profile_id  UUID,
  destinatario_nome        TEXT,
  destinatario_phone       TEXT,
  status                   TEXT NOT NULL CHECK (status IN
                             ('simulado', 'aguardando', 'assumido', 'resolvido', 'sem_destino', 'cancelado')),
  texto_briefing           TEXT,
  enviado_em               TIMESTAMPTZ,
  prazo_resposta           TIMESTAMPTZ,
  respondido_em            TIMESTAMPTZ,
  resposta                 TEXT,             -- 1, 2 ou 3
  nota                     TEXT,             -- o que veio depois do número
  historico                JSONB NOT NULL DEFAULT '[]',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_encaminhamento_chave ON acomp_encaminhamentos (chave);
CREATE INDEX IF NOT EXISTS idx_acomp_encaminhamento_aguardando
  ON acomp_encaminhamentos (destinatario_phone, enviado_em DESC) WHERE status = 'aguardando';
CREATE INDEX IF NOT EXISTS idx_acomp_encaminhamento_criado ON acomp_encaminhamentos (created_at DESC);

DROP TRIGGER IF EXISTS trg_acomp_encaminhamentos_updated ON acomp_encaminhamentos;
CREATE TRIGGER trg_acomp_encaminhamentos_updated
  BEFORE UPDATE ON acomp_encaminhamentos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE acomp_encaminhamentos IS
  'Encaminhamentos do acompanhamento ao professor (briefing por WhatsApp, respostas 1/2/3, repasse ao coordenador). '
  'Na fase de teste os da régua ficam "simulado"; só o envio de teste do painel sai.';

ALTER TABLE acomp_encaminhamentos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_encaminhamentos TO service_role;

NOTIFY pgrst, 'reload schema';

-- Conferência — 1 linha, rls_habilitado = true
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'acomp_encaminhamentos';
