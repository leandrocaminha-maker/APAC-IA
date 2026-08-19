# Estado do projeto — handoff

> Snapshot de 15/08/2026. Documento de continuidade: descreve onde o projeto
> parou e o que a próxima sessão deve fazer.
> Para o plano original, ver [implementation_plan.md](implementation_plan.md).

## Onde estamos

Fases 1 e 2 do plano estão implementadas, revisadas e **validadas ponta a ponta
contra o banco real**: contato → conversa → mensagem → histórico → resposta da
IA → handoff → fila, tudo passando.

O agente é hoje **conversacional + handoff**: não escreve em sistema nenhum, não
consulta o EVO e não promete voucher. É a superfície certa para escrever e testar
o prompt sem risco de efeito colateral em produção.

**O que falta para o uso real é conteúdo, não código**: os knowledge files ainda
estão em placeholder, e enquanto estiverem toda pergunta sobre valor ou horário
vira handoff.

## Configuração

| Item | Valor |
|---|---|
| Projeto Supabase | ref `aheoopiymromrnanhvoe` — Data API **ligada**, auto-expose de tabelas **desligada**, auto-RLS **ligada** |
| Projeto do AQUAP | `jlgailnbzybbhotmcuwc` — **não usado aqui**; a migration nunca rodou lá |
| Modelo | `claude-opus-5` via `@anthropic-ai/sdk` |

Banco separado do AQUAP por decisão desta sessão. Não há acoplamento: nenhuma
tabela `wa_*` referencia tabela do AQUAP — o vínculo com aluno é
`wa_contacts.evo_member_id`, que aponta para a API do EVO. Efeito colateral bom:
o anon key público do AQUAP não alcança os dados de WhatsApp.

⚠️ Com o *auto-expose de tabelas desligado*, **toda tabela nova precisa de GRANT
explícito** para aparecer na API — sem ele o sintoma é `PGRST205` ("not found in
schema cache"), que parece migration não aplicada. O padrão a copiar está no
bloco 8b da migration.

### Pendências de ambiente

No `.env` da VPS (`/var/www/apac-ia-sales/.env`), criado pelo `setup-vps.sh` a
partir do `.env.example`:

- ✅ `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — configuradas
  e verificadas em 19/08/2026: o agente respondeu pela VPS na página de teste
- ⚠️ `EVOLUTION_SERVER_URL` — ainda em `localhost:8080`; precisa do IP público
- ⚠️ `ADMIN_API_KEY` — confira se está preenchida; sem ela `/admin` responde 503

**Armadilha do `env_file`:** uma linha que não seja comentário, vazia ou
`VAR=valor` invalida o arquivo inteiro, e o `docker compose up` aborta **sem
recriar o container** — o sintoma é o serviço antigo continuar no ar como se o
deploy não tivesse acontecido. Aconteceu em 19/08/2026 com uma linha de
separação sem `#`. Para conferir antes de subir (silêncio = válido):

```bash
grep -vnE '^\s*(#|$)|^[A-Za-z_][A-Za-z0-9_]*=' .env
```

## Prompt: arquivo × banco

`src/prompts/vendas.md` é a fonte de verdade **para humanos**, mas o agente lê
o prompt de `wa_ai_prompts` — só os knowledge files vêm do disco. Editar o
arquivo não muda nada no atendimento até rodar:

```bash
npm run prompt            # publica vendas.md no banco (com backup do anterior)
npm run prompt -- --dry   # só compara os dois, sem gravar
```

Isso já mordeu uma vez: entre 15/08 e 19/08/2026 o arquivo dobrou de tamanho
(matriz de objeções, garantia de 21 dias, formas de pagamento, ponteiros para
`operacional-adulto.md` e `contrato-resumo.md`) enquanto o banco seguia na
versão de 15/08 — o agente atendia com um prompt que ninguém estava mais
editando. Sincronizado em 19/08/2026; a versão anterior ficou em
`data/backups/`.

O agente recarrega o prompt em até 5 minutos, ou na hora com
`POST /admin/reload-cache`.

## Página de teste — `/teste`

Sandbox web para o time conversar com a Leia sem WhatsApp. Serve para colocar
outras pessoas testando o roteiro e **juntar histórico real de conversa** para
ajustar prompt e base.

| Item | Valor |
|---|---|
| URL | `http://<IP_DA_VPS>:3100/teste` — sem domínio, IP direto |
| Senha | `Leia` (única, sem usuário) — troque em `TESTE_SENHA` |
| Canal no banco | `wa_conversations.channel = 'web-test'` |
| Desligar | `TESTE_HABILITADO=false` + restart |

### Subir na VPS

```bash
cd /var/www/apac-ia-sales
git pull
docker compose up -d --build backend
sudo ufw allow 3100/tcp        # se o firewall estiver ativo
```

Confira em `http://<IP>:3100/health` antes de mandar o link para o time.

### Como os testes ficam gravados

Cada aba de navegador vira um contato próprio, com telefone sintético
(`teste-<uuid>`), tag `teste-web` e conversa no canal `web-test`. Isso mantém a
análise num lugar só sem misturar com atendimento real: `/admin/metrics` conta
as conversas de teste num bloco `testes` à parte, fora de `conversations`.

O testador pode se identificar no campo de nome (é rótulo, não login) e usar
**Nova conversa** para zerar o contexto e repetir um roteiro do começo.

**Handoff se comporta diferente aqui de propósito:** ele é gravado em
`wa_human_handoffs` (com `[teste-web]` no motivo) e aparece na tela, mas **não
desliga a IA** — no WhatsApp o bot pararia, e o teste morreria justamente no
ponto que mais interessa avaliar.

### Coletar o histórico para análise

```bash
npm run conversas                      # últimos 30 dias, todos os canais
npm run conversas -- --canal=web-test  # só a página de teste
npm run conversas -- --dias=7
```

Gera `data/conversas/transcricoes.md` (para ler) e `conversas.json` (para
cruzar números), e imprime total de conversas, mensagens, taxa de handoff e os
motivos mais frequentes. Telefone de cliente sai mascarado; a pasta está no
`.gitignore`. O script lê o Supabase direto — precisa de `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY` no `.env` da máquina onde rodar.

Para espiar sem gerar arquivo: `GET /admin/conversas-teste` (header
`X-Api-Key`).

### Limites e riscos aceitos

- **É HTTP puro, sem TLS.** Senha e conversas trafegam em claro. Aceitável para
  uma sala de teste com senha compartilhada e dados fictícios — não use a página
  com dado real de cliente.
- **Cada resposta gasta crédito de API.** Por isso os tetos: 8 tentativas de
  senha por IP a cada 15 min, 1,2s entre mensagens, 80 mensagens por sessão e
  800 por dia (`TESTE_MAX_MSGS_*`).
- Os contadores vivem em memória: reiniciar o container zera todos.
- **Desligue a página quando a rodada de testes acabar** — senha curta em IP
  público não é para ficar no ar indefinidamente.

## O que foi feito nesta sessão

### Segurança

| Correção | Verificação |
|---|---|
| `/admin/*` estava **totalmente aberto** (QR code do WhatsApp e histórico de clientes). Agora exige `ADMIN_API_KEY`, com fail-closed (503 se a variável não existir) | `401` sem chave, `403` com chave errada, `200` com a correta |
| Webhook secret era contornável **omitindo o header** (`if (headerSecret && ...)`) | `401` sem secret, `200` com o correto |
| Sem RLS nas tabelas | RLS nas 6, sem policies; GRANT só para `service_role` |
| Postgres e Redis publicados no host com senha `postgres/postgres` | `ports:` removidos; acesso via `docker compose exec` |

### Correção

- **`supabase is not defined`** em `webhook.js` — import faltante derrubava toda
  atualização de status de mensagem com `ReferenceError`.
- **Histórico da conversa vinha invertido** — `ascending: true` + `limit(20)`
  trazia as *primeiras* 20 mensagens, congelando a memória do bot no início da
  conversa. Validado: o bot agora entende "e para crianças?" logo após uma
  resposta sobre adultos.
- **Mensagem atual chegava duplicada** — gravada pelo webhook e depois reenviada.
  Corrigido com `excludeMessageId`.
- **Migration não era idempotente** — `CREATE TYPE` e `CREATE TRIGGER` sem
  proteção abortavam a re-execução.
- **Guard de boot** conferindo se a chave e a URL do Supabase são do mesmo
  projeto, e se a chave é `service_role`. Nasceu de um diagnóstico caro: chave
  válida de outro projeto produz `PGRST205`, que parece migration não aplicada.
- **Sem default de `SUPABASE_URL`** — um default já apontou para um projeto
  depois deletado. Agora a falta da variável é reportada no boot.

### Troca de provedor de IA: Gemini → Claude

O SDK `@google/generative-ai` estava fora de suporte desde 31/08/2025. Migrado
para `@anthropic-ai/sdk` com `claude-opus-5`.

O que mudou: SDK, model ID, formato do schema das tools (`parameters` →
`input_schema`, tipos minúsculos), papéis do histórico (`model` → `assistant`) e
a variável de ambiente. Handlers, guard contra inventar preço e lógica de handoff
ficaram intactos.

Três decisões que valem conhecer antes de mexer:

- **Prompt caching** — o system vai em dois blocos: prompt + knowledge (idênticos
  em toda mensagem) levam o breakpoint de cache; o contexto do contato fica
  **depois** dele. Se o contexto viesse antes, cada contato diferente
  invalidaria o cache. Medido: segunda chamada lê 100% do prefixo do cache.
  Há um log de `cache_leitura` — se ficar sempre em zero, algo variável entrou
  no prefixo.
- **Thinking fica ligado**, com `effort: 'low'`. Desligar reduziria latência,
  mas nesse modo o Opus 5 ocasionalmente escreve a chamada de tool como texto
  comum: o turno termina sem erro e a tool nunca executa — aqui seria um handoff
  pedido pelo cliente que ninguém recebe.
- **Loop manual** em vez do tool runner do SDK, porque o handoff precisa
  interromper o turno e retornar na hora para o webhook pausar o bot.

De brinde: `maxRetries: 3`. O SDK reenvia sozinho em 429 e 5xx — antes não havia
retry nenhum, e um 503 transitório derrubava o atendimento.

### Escopo do agente

Consultas de informação ao EVO **desativadas** por decisão sua — planos, valores,
modalidades e grade saem dos arquivos em `src/prompts/knowledge/`. As tools
`buscar_planos`, `buscar_horarios` e `buscar_modalidades` foram removidas.

Isso exigiu alinhar o que apontava para elas: o prompt semeado (regras 4 a 7), o
preâmbulo dos knowledge files em `ai-agent.js` (que agora declara os arquivos
como fonte única de verdade e proíbe inventar valor) e um `NO_KNOWLEDGE_GUARD`
para quando os arquivos não carregarem.

Verificado com os arquivos ainda em placeholder: perguntado o preço da natação
adulto, o bot **não inventou** — transferiu para humano.

## Tools pausadas

Em `src/services/ai-tools.js`. Declaração e handler continuam no arquivo; para
reativar, remova o nome de `PAUSED_TOOLS`.

| Tool | Por que está pausada |
|---|---|
| `emitir_voucher` | gera código que **não é persistido** — o cliente receberia voucher irresgatável. Precisa de tabela de vouchers antes. |
| `cadastrar_prospect` | usa `POST /api/v1/members`, que cria **membro**, não prospect. O correto é `POST /api/v1/prospects` (confirmado existente). |
| `agendar_aula_experimental` | depende do endpoint acima e nunca foi validado contra o EVO — é escrita em produção. |

Bloqueio duplo: além de não serem declaradas, `executeTool` recusa executá-las
caso o modelo alucine a chamada. **Tool ativa: apenas `transferir_para_humano`.**

## Próxima sessão

### Tarefa combinada

Fazer o agente ler o prompt de **arquivo local** quando o banco estiver
indisponível, para escrever e testar o prompt offline e subir para
`wa_ai_prompts` depois. Os knowledge files já funcionam assim.

Hoje `loadPrompt()` em `ai-agent.js` cai num fallback genérico de uma linha
quando a leitura falha — é esse caminho que vira leitura de arquivo.

### O que destrava o uso real

~~`src/prompts/knowledge/` está 100% placeholder~~ — **resolvido**. A base tem
planos, valores, grade real, metodologia infantil, anamnese e o resumo do
contrato. O que sobrou de `PENDENTE` está listado em `INFORMACOES-PENDENTES.md`.

O que trava agora é outra coisa: **handoff não notifica ninguém**. Os testes de
19/08/2026 terminaram 3 em 3 conversas em handoff (agendamento pelo FITI,
negociação de taxa de adesão e marcação de aula experimental) — todos
comportamentos corretos do bot, e todos parando numa fila que ninguém olha.

### Ainda não exercitado

O webhook da Evolution está configurado no `docker-compose.yml` (global, com
`BY_EVENTS=false` e o secret na query string), mas **nunca foi testado com uma
instância real**. O fluxo inbound WhatsApp → Evolution → backend continua não
verificado ponta a ponta.

⚠️ Em 19/08/2026 o container `evolution-api` estava em **loop de restart**
(`Restarting (1)`) na VPS. Não afeta a página de teste, que não passa pelo
WhatsApp, mas é o primeiro obstáculo de quem for atacar o canal real:
`docker compose logs --tail 50 evolution` mostra o motivo.

## Backlog conhecido (não tratado)

- **Handoff não notifica ninguém** — só grava linha em `wa_human_handoffs` e para
  de responder. Se ninguém abrir `/admin/handoffs`, o cliente fica no vácuo.
  É a lacuna mais relevante para uso real.
- **Fila pode travar em `processing`** — se o processo cair após marcar o status,
  a linha nunca volta para `pending` e a query só busca `pending`.
- **Zero testes commitados** — `npm test` aponta para `src/**/*.test.js`, que não
  existe. As validações desta sessão foram scripts descartáveis.
- **Evolution na 8080 poderia ser fechada** — o backend fala com ela por dentro
  da `apac-network` e o QR sai por `/admin/whatsapp/qrcode`.
- **`ai_enabled` é gravado mas nunca lido** — só `status === 'human'` é checado.
- **Telefone não é normalizado** antes das buscas no EVO.
- **CORS só lista `localhost`** em `server.js`; faltam os domínios de produção.

### Fora deste repositório

O arquivo `test-evo-experimental.js` do **AQUAP** tem o token do EVO em texto
puro e commitado. Vale rotacionar.

## Referência: endpoints do EVO

Levantado por teste direto (`GET` apenas — nada foi escrito em produção). Útil se
as tools de ação forem retomadas.

| Endpoint | Status | Observação |
|---|---|---|
| `/api/v1/services` | **404** | é o que o código usava — não existe |
| `/api/v1/service` | `200` | serviços avulsos (ex. MATRÍCULA) — `nameService`, `value` |
| `/api/v1/membership` | `200` | **planos/mensalidades** — `nameMembership`, `value`, `duration` |
| `/api/v1/activities` | `200` | modalidades — `name`, `description` |
| `/api/v1/activities/schedule` | `200` | grade — `name`, `activityDate`, `startTime`, `instructor` |
| `/api/v1/prospects` | `200` | `idProspect`, `cellphone` |
| `/api/v1/members` | `200` | filtro `?phone=` funciona |

⚠️ O campo de ativido é **`inactive`**, não `isActive`. O código antigo filtrava
por `s.isActive !== false`, que com o campo ausente resultava em `true` — ou
seja, **planos inativos seriam oferecidos ao cliente**. Tratar isso se retomar
as consultas.
