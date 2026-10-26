-- ============================================================
-- APAC-IA SALES — o registro das vendas de plano, por canal
--
-- Rode no SQL Editor do Supabase, DEPOIS da 002. É IDEMPOTENTE. Aplicar
-- ANTES do deploy: sem esta tabela o webhook continua fechando o lead como
-- ganho, mas a venda não é registrada e o painel do período fica vazio
-- (o log grita "migration 020 não aplicada").
--
-- ⚠️ Auto-expose está DESLIGADO: sem os GRANTs a API responde PGRST205 e
-- parece migration não aplicada.
--
-- Pedido do responsável em 26/10/2026: o painel precisa mostrar o
-- desempenho de cada caminho do funil — quem comprou depois de falar pelo
-- WhatsApp e quem comprou atendido no balcão (balcão aqui é tudo o que não
-- é WhatsApp: recepção, telefone, e-mail).
--
-- POR QUE UMA TABELA, E NÃO `crm_leads`
--
-- `crm_leads` só conhece quem escreveu no WhatsApp. A venda de balcão não
-- tem lead, e era justamente ela que faltava para comparar os dois
-- caminhos. Além disso, até 26/10/2026 a maior parte das vendas de quem
-- falou pelo WhatsApp nunca chegou ao lead: a venda feita no balcão chega
-- do EVO com o número de ALUNO novo, e o lead só conhecia o de prospect.
-- Medido: 56 vendas a novos e ex-alunos que tinham falado pelo WhatsApp,
-- 20 delas como ganho no painel.
--
-- Uma linha por venda de plano PAGO (`NewSale` com contrato acima de R$ 0).
-- Produto, serviço avulso, cortesia e mensalidade recorrente ficam de fora.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_vendas (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- A venda, como o EVO a registrou
  evo_id_sale         BIGINT NOT NULL,
  evo_id_member       BIGINT,
  sale_at             TIMESTAMPTZ NOT NULL,            -- saleDate do EVO
  valor               NUMERIC(12,2) NOT NULL,          -- soma dos itens da venda
  planos              TEXT[] NOT NULL DEFAULT '{}',

  -- Quem comprou. `novo` nunca teve contrato pago; `ex_aluno` estava sem
  -- contrato havia EVO_MESES_REATIVACAO meses ou mais; `aluno_ativo` é
  -- renovação ou troca de plano, e não conta como venda do funil.
  comprador           TEXT NOT NULL,
  meses_sem_contrato  NUMERIC(6,1),

  -- Por onde chegou. `whatsapp`: falou com a gente pelo WhatsApp antes de
  -- comprar (atendimento aberto, ou criado nos 60 dias anteriores).
  canal               TEXT NOT NULL,

  -- O atendimento que a venda fechou, quando há um.
  lead_id             BIGINT REFERENCES crm_leads(id) ON DELETE SET NULL,

  -- Quem vendeu (`idEmployeeSale`) e por onde o EVO diz que a venda entrou
  -- (`saleSource`: 1 = balcão, 7 = integração).
  vendedor_id         INT,
  vendedor_nome       TEXT,
  origem_evo          INT,

  telefone            TEXT,
  webhook_event_id    BIGINT REFERENCES crm_evo_webhook_events(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE crm_vendas
    ADD CONSTRAINT crm_vendas_comprador_check CHECK (comprador IN ('novo', 'ex_aluno', 'aluno_ativo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE crm_vendas
    ADD CONSTRAINT crm_vendas_canal_check CHECK (canal IN ('whatsapp', 'balcao'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- O EVO reentrega webhook; a mesma venda não pode virar duas linhas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_vendas_sale ON crm_vendas (evo_id_sale);
CREATE INDEX IF NOT EXISTS idx_crm_vendas_data   ON crm_vendas (sale_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_vendas_lead   ON crm_vendas (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_vendas_membro ON crm_vendas (evo_id_member);

ALTER TABLE crm_vendas ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_vendas TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
