-- ============================================================
-- APAC-IA SALES — Campanha: segmento vindo do EVO e porta de consentimento
--
-- Rode no SQL Editor do Supabase, DEPOIS da 005. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem GRANT a API responde PGRST205.
--
-- POR QUE
--
-- Duas descobertas de 25/08/2026 mudaram o desenho da campanha.
--
-- 1. O EVO entrega a coorte pronta. A automação de CRM dispara
--    `crm.segmentation.batch`, um POST por pessoa, com telefone, idMember e
--    um LINK DE CHECKOUT tokenizado por pessoa. O primeiro disparo real
--    trouxe 47 pessoas em 2,6 segundos. Isso é melhor do que a varredura em
--    `segmentos.js`: filtra por modalidade e janela de datas, que a API não
--    sabe fazer, e não gasta cota.
--
--    Mas o `eventType` é o MESMO para todo segmento. Quem distingue um
--    segmento do outro é o texto em `communication.message` — por isso o
--    vínculo com a campanha é por esse texto.
--
-- 2. A abordagem tem duas etapas, não uma. A primeira mensagem só pede
--    licença ("temos uma condição especial, tem interesse de saber?"). A
--    oferta só vai para quem disse que sim. Isso exige guardar em que ponto
--    da conversa cada alvo está.
-- ============================================================

-- ────────────────────────────────────────
-- Campanha: o que a liga ao segmento do EVO e o que ela diz na abertura
-- ────────────────────────────────────────

-- Casa com `communication.message` do payload — a descrição do segmento
-- escrita na tela do EVO. Renomear o segmento lá quebra o vínculo, por isso
-- a convenção é começar a descrição com um código entre colchetes.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS evento_gatilho TEXT;

-- O que a PRIMEIRA mensagem diz: por que estamos falando com a pessoa.
-- Separado de `oferta` de propósito — na abertura a oferta ainda não é
-- revelada, só se pede licença para apresentá-la.
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS motivo_contato TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_campanhas_gatilho
  ON crm_campanhas (evento_gatilho) WHERE evento_gatilho IS NOT NULL;

-- ────────────────────────────────────────
-- Alvo: em que ponto da conversa está
--
--   NULL                     ainda não recebeu nada
--   aguardando_consentimento primeira mensagem enviada, esperando sim/não
--   aceitou                  disse que sim; recebeu (ou vai receber) a oferta
--   recusou                  disse que não; encerrado, marcado no funil
--   conversando              foi além do sim/não — o agente completo assumiu
--
-- É esta coluna que evita rodar o prompt de vendas inteiro (~48.000 tokens)
-- para interpretar um "sim". Só quem chega em `conversando` custa isso.
-- ────────────────────────────────────────
ALTER TABLE crm_campanha_alvos ADD COLUMN IF NOT EXISTS etapa_conversa TEXT;

-- Link de checkout tokenizado que veio no payload. Fica em coluna própria,
-- e não no `contexto`, porque é o que a mensagem principal precisa ter em
-- mãos — e porque é dado por pessoa que não se recupera depois: se o evento
-- for descartado, não há API que devolva este link.
ALTER TABLE crm_campanha_alvos ADD COLUMN IF NOT EXISTS link_checkout TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_alvos_etapa
  ON crm_campanha_alvos (phone, etapa_conversa)
  WHERE etapa_conversa IS NOT NULL;

-- ────────────────────────────────────────
-- A view precisa ser recriada para enxergar as etapas de conversa
--
-- DROP antes do CREATE, e não CREATE OR REPLACE: o `replace` só aceita
-- ACRESCENTAR colunas no fim da lista. As três novas (aceitaram, recusaram,
-- conversando) entram no meio, junto das outras contagens, onde se lê
-- melhor — e aí o Postgres recusa com:
--
--   42P16: cannot change name of view column "enviados_hoje" to "aceitaram"
--
-- A view não tem dependentes, então derrubar é barato. O GRANT é refeito
-- logo abaixo porque DROP leva os privilégios junto.
-- ────────────────────────────────────────
DROP VIEW IF EXISTS crm_campanhas_resumo;

CREATE VIEW crm_campanhas_resumo AS
SELECT
  c.id, c.slug, c.titulo, c.tipo, c.status, c.teto_diario,
  COUNT(a.id)                                                   AS alvos,
  COUNT(*) FILTER (WHERE a.status = 'pendente')                 AS pendentes,
  COUNT(*) FILTER (WHERE a.status = 'agendado')                 AS agendados,
  COUNT(*) FILTER (WHERE a.status = 'enviado')                  AS enviados,
  COUNT(*) FILTER (WHERE a.status = 'respondeu')                AS responderam,
  COUNT(*) FILTER (WHERE a.status = 'suprimido')                AS suprimidos,
  COUNT(*) FILTER (WHERE a.status = 'erro')                     AS erros,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'aceitou')          AS aceitaram,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'recusou')          AS recusaram,
  COUNT(*) FILTER (WHERE a.etapa_conversa = 'conversando')      AS conversando,
  COUNT(*) FILTER (WHERE a.sent_at::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
                                                                AS enviados_hoje,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'respondeu')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu')), 0), 3
  )                                                             AS taxa_resposta,
  ROUND(
    COUNT(*) FILTER (WHERE a.etapa_conversa = 'aceitou')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.etapa_conversa IN ('aceitou','recusou','conversando')), 0), 3
  )                                                             AS taxa_aceite,
  ROUND(
    COUNT(*) FILTER (WHERE a.status = 'suprimido')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE a.status IN ('enviado', 'respondeu', 'suprimido')), 0), 3
  )                                                             AS taxa_supressao,
  c.limiar_supressao, c.pausada_motivo, c.created_at
FROM crm_campanhas c
LEFT JOIN crm_campanha_alvos a ON a.campanha_id = c.id
GROUP BY c.id
ORDER BY c.created_at DESC;

GRANT SELECT ON crm_campanhas_resumo TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve listar as 4 colunas novas
-- ────────────────────────────────────────
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'crm_campanhas'      AND column_name IN ('evento_gatilho','motivo_contato'))
    OR (table_name = 'crm_campanha_alvos' AND column_name IN ('etapa_conversa','link_checkout'))
  )
ORDER BY table_name, column_name;
