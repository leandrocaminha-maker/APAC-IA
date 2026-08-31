-- ============================================================
-- APAC-IA SALES — Ramificação do funil: venda x relacionamento
--
-- Rode no SQL Editor do Supabase, DEPOIS da 009. É IDEMPOTENTE.
--
-- ⚠️ Não cria tabela nova — só colunas e tipos. Por isso não há GRANT
-- aqui: `crm_leads` (002) e `wa_contacts` (001) já têm o seu.
--
-- O PROBLEMA
--
-- `garantirLeadDoContato` abre uma linha em `crm_leads` para TODO contato
-- que escreve no WhatsApp, e o número é o principal da academia. Entram
-- pelo mesmo funil de venda:
--
--   quem quer comprar          → é lead
--   aluno matriculado          → não é lead, já comprou
--   cliente de convênio        → não é lead, o plano dele vem de fora
--   fornecedor, vendedor       → nunca foi lead
--
-- Com todos na mesma tabela, "leads abertos" conta quem já é aluno,
-- "parados há 2+ dias" conta o fornecedor que não tinha o que responder, e
-- a conversão sai dividida por um denominador cheio de gente que nunca
-- esteve comprando. A leitura do painel deixa de valer.
--
-- A SOLUÇÃO
--
--   trilha = 'lead'           → funil de venda, como sempre foi
--   trilha = 'relacionamento' → CONVERSAS → COM CONSULTOR → FINALIZADAS
--
-- As três primeiras etapas são as MESMAS nas duas trilhas (`em_conversa`,
-- `aguardando_consultor`, `com_consultor`): chegar mensagem, abrir handoff
-- e o consultor assumir acontecem igual dos dois lados, e são os mesmos
-- gatilhos que movem. O que muda é o fim da linha — `ganho`/`perdido` de
-- um lado, `finalizado` do outro.
--
-- QUEM DECIDE A TRILHA
--
-- A Leia, pela tool `definir_tipo_atendimento`, assim que a conversa deixa
-- claro com quem ela fala; e o consultor, pelo painel, quando ela erra. O
-- tipo fica gravado no CONTATO (`wa_contacts.tipo_contato`) para o próximo
-- atendimento do mesmo número já nascer na trilha certa — sem isso o mesmo
-- aluno voltaria a ser lead toda vez que abrisse conversa.
-- ============================================================

-- ────────────────────────────────────────
-- 1. Tipos
-- ────────────────────────────────────────

-- O que o contato é. É o fato observado; a trilha é a consequência dele.
-- Guardar os dois permite perguntar "quantos atendimentos de convênio
-- tivemos?" sem perder a pergunta mais simples ("isto é venda ou não?").
DO $$ BEGIN
  CREATE TYPE crm_tipo_contato AS ENUM (
    'lead',        -- quer conhecer, contratar, voltar a treinar
    'aluno',       -- matriculado: rotina, contrato, app, financeiro
    'convenio',    -- convênio ou agregador (o plano dele vem de fora)
    'fornecedor',  -- fornecedor, vendedor, prestador
    'outro'        -- qualquer outro assunto que não é academia
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE crm_trilha AS ENUM ('lead', 'relacionamento');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ────────────────────────────────────────
-- 2. Colunas
--
-- O padrão é `lead` nas duas: é o que toda linha existente era antes de
-- haver ramificação, e assumir venda para quem ainda não foi classificado
-- é o erro barato (a Leia corrige na primeira mensagem em que der para
-- saber; o contrário esconderia lead de verdade do funil).
--
-- `wa_contacts.tipo_contato` é NULL quando ninguém classificou ainda —
-- diferente de 'lead', que é alguém tendo afirmado que é lead.
-- ────────────────────────────────────────
ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS trilha       crm_trilha       NOT NULL DEFAULT 'lead',
  ADD COLUMN IF NOT EXISTS tipo_contato crm_tipo_contato NOT NULL DEFAULT 'lead';

ALTER TABLE wa_contacts
  ADD COLUMN IF NOT EXISTS tipo_contato crm_tipo_contato;

-- ────────────────────────────────────────
-- 3. Índices
-- ────────────────────────────────────────

-- A tela do funil e a do relacionamento são a MESMA consulta com trilha
-- diferente. Sem a trilha na frente do índice, uma das duas vira scan.
CREATE INDEX IF NOT EXISTS idx_crm_leads_trilha
  ON crm_leads (trilha, stage, last_activity_at DESC);

-- Um contato tem no máximo UM atendimento aberto — agora com `finalizado`
-- contando como fechado. Sem recriar este índice, o aluno cujo atendimento
-- foi finalizado não conseguiria abrir o próximo: a UNIQUE veria a linha
-- finalizada como aberta e o INSERT bateria em 23505.
DROP INDEX IF EXISTS uq_crm_leads_contato_aberto;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_leads_contato_aberto
  ON crm_leads (contact_id)
  WHERE contact_id IS NOT NULL AND stage NOT IN ('ganho', 'perdido', 'finalizado');

-- A varredura de silêncio agora só olha a trilha de venda (ver
-- `varrerSilenciosos`). O índice da 007 não tinha a trilha e passou a
-- cobrir a consulta pela metade.
DROP INDEX IF EXISTS idx_crm_leads_atividade;
CREATE INDEX IF NOT EXISTS idx_crm_leads_atividade
  ON crm_leads (last_activity_at DESC)
  WHERE trilha = 'lead' AND stage NOT IN ('ganho', 'perdido', 'finalizado');

-- ────────────────────────────────────────
-- 4. Carga inicial
--
-- Não há backfill de classificação, e é de propósito: quem é aluno hoje
-- só se sabe perguntando ao EVO, e adivinhar aqui gravaria erro
-- permanente no contato. As linhas existentes ficam como `lead` (o que
-- eram) e vão sendo classificadas conforme as pessoas escrevem.
--
-- A única inferência segura é a que o próprio sistema já registrou: quem
-- tem venda fechada no funil é aluno. `mudarEtapa` passa a marcar isso
-- sozinho a cada novo `ganho`; aqui vale para o que já aconteceu.
-- ────────────────────────────────────────
UPDATE wa_contacts c
   SET tipo_contato = 'aluno'
  FROM crm_leads l
 WHERE l.contact_id = c.id
   AND l.stage = 'ganho'
   AND c.tipo_contato IS NULL;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- 5. Conferência
--
-- A primeira deve mostrar as duas colunas novas em crm_leads; a segunda,
-- quantas linhas ficaram em cada trilha (tudo em 'lead' numa base que
-- ainda não classificou ninguém).
-- ────────────────────────────────────────
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE (table_name = 'crm_leads' AND column_name IN ('trilha', 'tipo_contato'))
   OR (table_name = 'wa_contacts' AND column_name = 'tipo_contato')
ORDER BY table_name, column_name;

SELECT trilha, tipo_contato, count(*) AS linhas
FROM crm_leads
GROUP BY trilha, tipo_contato
ORDER BY trilha, tipo_contato;
