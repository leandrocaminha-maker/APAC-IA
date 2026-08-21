# Estado do projeto — handoff

> **Snapshot de 20/08/2026, fim do dia.** Documento de continuidade: descreve
> onde o projeto parou e o que a próxima sessão deve fazer.
> Para o plano original, ver [implementation_plan.md](implementation_plan.md).
> Para os achados de prompt e base — aplicados e pendentes — ver
> [REVISAO-PROMPT.md](REVISAO-PROMPT.md).

## Comece por aqui — 21/08/2026

**O dia 20/08 foi longo.** O prompt saiu de 18,5 mil para ~42 mil caracteres, a
base ganhou um arquivo, o serviço saiu do IP nu para HTTPS em domínio próprio, e
as transcrições foram lidas duas vezes. Onze commits.

**Três coisas para saber antes de tocar em qualquer coisa:**

1. **A URL mudou.** A página de teste agora é
   **`https://leia.apacademia.com.br/teste`**. O acesso por
   `http://108.174.151.51:3100` foi fechado de propósito — a porta só escuta no
   loopback e o nginx é a única entrada. **Avise o time**, o link antigo morreu.
2. **Está tudo publicado e no ar.** Prompt no banco, knowledge files e código na
   VPS. Nada pendente de `npm run prompt` nem de deploy.
3. **Nada do que mudou hoje foi testado em volume.** As 13 conversas com o
   prompt novo são um começo, não uma amostra.

### A decisão que ficou aberta

**A porta 8080 da Evolution continua exposta na internet**, em HTTP puro,
protegida só pela `AUTHENTICATION_API_KEY`. Quem tiver essa chave controla o
WhatsApp da academia — é exposição maior do que a da 3100 que acabamos de fechar.

Não foi fechada para não bloquear a conexão do número, que é iminente. As opções,
na ordem em que eu recomendaria:

1. Fechar no loopback e pegar o QR por `/admin/whatsapp/qrcode`, que já existe e
   agora sai por HTTPS. Precisando do manager da Evolution, túnel SSH.
2. Publicar atrás do nginx, com TLS, em caminho ou subdomínio próprio.
3. Deixar como está até conectar o WhatsApp, e fechar logo depois.

### O que vinha a seguir

O objetivo que motivou o domínio e o TLS: **um painel para o consultor**. Fila de
handoffs → abrir e ler a conversa → responder, agendar follow-up, devolver para a
Leia. O raciocínio inteiro e o que já existe pronto estão no **bloco 11** da
revisão.

Resumo do porquê: a Leia não pode agendar o follow-up no momento do handoff,
porque ali ela só tem a **intenção** ("quer experimental amanhã 9h20"). Quem cria
o **fato** é o consultor, depois, no FITI — e pode ser outro horário, ou plano
fechado sem experimental nenhuma. Então quem enfileira tem que ser ele.

Falta para o painel: um endpoint que devolva mensagens **por id de conversa** (só
existe por telefone, na API de integração), um para responder pelo painel, e a
página. O login por cookie assinado já existe e funciona na `/teste`; a fila de
handoffs, a reativação do bot e o enfileiramento com `scheduled_for` também.

## Onde estamos

Fases 1 e 2 do plano estão implementadas, revisadas e **validadas ponta a ponta
contra o banco real**: contato → conversa → mensagem → histórico → resposta da
IA → handoff → fila, tudo passando.

O agente é hoje **conversacional + handoff**: não escreve em sistema nenhum, não
consulta o EVO e não promete voucher. É a superfície certa para escrever e testar
o prompt sem risco de efeito colateral em produção.

⚠️ **O WhatsApp nunca foi conectado.** A instância `apacademia` não existe na
Evolution (`webhook/find` devolve *"instance does not exist"*), então o canal real
está desligado e a `/teste` é a única superfície viva. Foi isso que tornou seguro
fechar a 3100: não há webhook externo chamando.

**Fase atual: rodada de testes.** A base está preenchida, o prompt publicado e a
página no ar. O foco é o time testar situações variadas; a próxima rodada precisa
exercitar de propósito o que mudou em 20/08 — pedir desconto, reclamar de preço,
pedir cancelamento com motivo raso, esquecer um objeto, não conseguir agendar.

As transcrições **foram lidas duas vezes em 20/08** (blocos 8 e 10 da revisão).
Para regenerar:

```bash
node scripts/exportar-conversas.js --canal=web-test
```

⚠️ **Ao ler transcrições, corte a conversa no primeiro handoff.** A `/teste` não
desliga a IA de propósito, mas o WhatsApp desliga — 31% das respostas do corpus
descrevem um bot que em produção já estaria pausado.

⚠️ **Referência para comparar rodadas: 78% de handoff** com o prompt antigo (14
em 18 conversas). Com o prompt novo, 62% em 13 conversas — mas o que mudou foi a
natureza: 5 dos 8 são lead qualificado indo fechar, e nenhum é por preço,
desconto ou FITI.

O `npm run` está barrado no Windows do Leandro pela política de execução do
PowerShell (`npm` é um `.ps1`) — por isso a chamada direta ao `node`.

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

### Acesso à VPS

| Item | Valor |
|---|---|
| Host | `root@108.174.151.51`, porta **22022** |
| Chave | `~/.ssh/aquap_vps` — **é esta**; as `id_ed25519_vps` e `id_rsa_vps` não estão autorizadas neste servidor |
| Projeto | `/var/www/apac-ia-sales` |
| Domínio | **`leia.apacademia.com.br`** — Cloudflare na frente, nginx terminando TLS na VPS |

```bash
ssh -p 22022 -i ~/.ssh/aquap_vps root@108.174.151.51
```

### nginx e TLS — montado em 20/08/2026

A VPS já servia `apacademia`, `aqua` e `pagtos` pelo nginx, com um `.conf` por
subdomínio em `/etc/nginx/conf.d/` e certbot. O `leia.conf` seguiu esse padrão e
faz `proxy_pass` para `localhost:3100`.

| | |
|---|---|
| Certificado | Let's Encrypt, expira **19/11/2026**, já no `certbot-renew.timer` |
| Porta 3100 | **só no loopback** (`127.0.0.1:3100:3100` no compose) — nginx é a única entrada |
| Porta 8080 | **ainda aberta em `0.0.0.0`** — ver "A decisão que ficou aberta", no topo |

⚠️ **Se algum dia precisar emitir certificado para um subdomínio novo:** a
Cloudflare está em **Full (strict)** e fala HTTPS com o origin. Domínio sem
certificado ainda no origin faz ela devolver **526**, e o desafio HTTP-01 do
certbot nunca chega ao nginx. A saída é passar o registro para **DNS only**
(nuvem cinza) na Cloudflare, emitir, e religar o proxy. Vale só para a primeira
emissão — renovação funciona com o proxy ligado, que é como os outros renovam.

Deploy completo (código e knowledge files; o prompt não passa por aqui):

```bash
cd /var/www/apac-ia-sales && git pull && docker compose up -d --build backend
```

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
| URL | **`https://leia.apacademia.com.br/teste`** — o acesso por IP na 3100 foi fechado em 20/08 |
| Senha | `Leia` (única, sem usuário) — troque em `TESTE_SENHA` |
| Canal no banco | `wa_conversations.channel = 'web-test'` |
| Desligar | `TESTE_HABILITADO=false` + restart |

### Subir na VPS

```bash
cd /var/www/apac-ia-sales
git pull
docker compose up -d --build backend
```

Confira em `https://leia.apacademia.com.br/health` antes de mandar o link para o
time. Não abra a 3100 no firewall: ela escuta só no loopback de propósito.

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

- ~~**É HTTP puro, sem TLS.**~~ **Resolvido em 20/08/2026:** a página só é
  servida por `https://leia.apacademia.com.br`. Continua valendo a ressalva da
  **senha padrão `Leia`**, única e compartilhada — troque em `TESTE_SENHA`, ou
  desligue com `TESTE_HABILITADO=false` quando a rodada acabar. O backend avisa
  isso no log a cada restart.
- **Cada resposta gasta crédito de API.** Por isso os tetos: 8 tentativas de
  senha por IP a cada 15 min, 1,2s entre mensagens, 80 mensagens por sessão e
  800 por dia (`TESTE_MAX_MSGS_*`).
- Os contadores vivem em memória: reiniciar o container zera todos.
- **Desligue a página quando a rodada de testes acabar** — senha curta em IP
  público não é para ficar no ar indefinidamente.

## O que foi feito em 20/08/2026

Onze commits, de `d07d4df` a `0808af3`. O detalhe de cada achado está nos blocos
8 a 11 de [REVISAO-PROMPT.md](REVISAO-PROMPT.md); aqui fica o mapa.

### Prompt e base — a auditoria de 19/08 foi aplicada por inteiro

- **Ancoragem de preço reescrita como regra de turno.** A instrução mandava
  "aguarde 10 segundos", que o modelo não tem como cumprir — e o ramo "se não
  houver resposta, apresente o Anual" nunca disparava, porque o agente só roda
  quando chega mensagem. Agora: Mensal com a adesão, descartado na mesma frase →
  Assinatura descrita → Anual no turno seguinte, com teto de dois turnos. O "é o
  que eu indico" aparece **uma vez só**, no Anual.
- **Régua da Objeção 4** para desconto e "está caro", com a política nova: 10%
  para 65+, 10% por integrante em família de 3 ou mais, sem acúmulo, **e nenhuma
  negociação**. Pedido de desconto deixou de ser motivo de handoff.
- **As quatro regras de handoff que disparavam cedo demais** foram reescopadas —
  Financeiro, aula experimental, FITI e "dado fora da base".
- **Roteiro da frente 2 (aluno matriculado) começou:** objeto esquecido, app
  FITI, afastamento médico, troca de horário e cancelamento de contrato.
- **Todas as contradições da base fechadas** (bloco 3), mais o mapeamento de
  nível ↔ frequência da natação infantil.
- Novo `knowledge/suporte-fiti.md`.

### Código

- **O agente ganhou relógio** — data, dia da semana e hora em `America/Sao_Paulo`
  no system, depois do `cache_control`. Sem isso ele não respondia "tem aula
  hoje?" com a grade inteira no contexto.
- **O bloco de contato parou de sumir** quando não havia nome, o que levava junto
  o `is_prospect`.
- **Mensagens do consultor no WhatsApp deixaram de ser descartadas** — o
  `key.fromMe` era `return` puro, e tudo o que o humano digitava sumia.
- **Infra:** domínio, TLS, porta 3100 fechada, CORS.

### As duas leituras de transcrição

A primeira (bloco 8) achou que 31% das respostas do corpus nunca teriam sido
enviadas em produção, e que 6 conversas tinham handoff duplicado — uma com sete.
A segunda (bloco 10), já com o prompt novo, achou zero duplicados, zero preço
fora da base, e que a palavra "virtual" tinha sumido das aberturas.

**O padrão que se repetiu:** quase todo defeito encontrado veio de instrução
minha lida ao pé da letra — "uma linha mesmo" comeu o "virtual", "vá direto ao
assunto" comeu a identificação, "não adiante isenção de adesão" fez a Assinatura
ser apresentada sem a taxa. Vale a suspeita ao escrever a próxima regra.

## O que foi feito na sessão de 19/08/2026

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

### Onde retomar

**Está tudo publicado e no ar** — prompt no banco, base e código na VPS. Nada
esperando `npm run prompt` nem deploy. Confira com:

```bash
npm run prompt -- --dry   # deve dizer "O banco já está igual ao arquivo"
```

Duas frentes, e a segunda depende de gente:

**1. O painel do consultor.** É o que motivou o domínio e o TLS de 20/08, e o
raciocínio inteiro está no bloco 11 da revisão. Eu começaria por aqui.

**2. Uma bateria de testes com foco no que mudou.** Não dá para pedir ao time
enquanto o painel não existir, mas é o que valida o dia 20/08. Roteiros a
exercitar de propósito, porque nenhum foi: pedir desconto, reclamar de preço,
pedir cancelamento com um motivo raso, esquecer um objeto, não conseguir agendar
no FITI, perguntar sobre atendimento a PCD.

### O que ainda mexe no resultado e continua pendente

0. **Fechar a 8080 da Evolution**, ou decidir conscientemente não fechar — ver
   "A decisão que ficou aberta", no topo. É o item de segurança em aberto.
1. **Não existe sinal de lead vs aluno** (bloco 9 da revisão) — `is_prospect`
   nasce `true` e nada o põe em `false`; `evo_member_id` existe no schema e
   ninguém preenche (0 de 11 contatos). A abertura foi reescrita para não
   presumir, mas isso é contorno: preencher o `evo_member_id` na criação do
   contato é o que resolve.
2. **Follow-up agendado** (bloco 7 da revisão) — `wa_message_queue.scheduled_for`,
   o worker e a rota já existem e ninguém enfileira mensagem futura. Enquanto
   isso, quem some depois de ver preço some em silêncio.
3. **Follow-up depois do consultor** (bloco 11) — a reativação existe
   (`POST /admin/conversations/:id/reactivate`), e desde 20/08/2026 o que o
   consultor digita no WhatsApp é gravado. Falta o gatilho, a retomada agendada e
   a instrução no prompt para a Leia ler o que foi combinado antes de falar.
   ⚠️ Efeito colateral já visível: se o consultor responder com a conversa ainda
   `active`, ele e o bot falam ao mesmo tempo — decidir se mensagem humana pausa
   o bot é decisão de operação, ainda não tomada.
4. **A frente 2 (aluno já matriculado) tem roteiro desde 20/08/2026**, mas ele
   está no começo: cobre objeto esquecido, dificuldade com o app FITI
   (`suporte-fiti.md`), afastamento médico, troca de horário e cancelamento de
   contrato. Falta o resto do que chega de aluno, como reposição de aula. Continua
   sendo a maior lacuna de escopo para quando o WhatsApp principal entrar no ar,
   porque ali a maioria do volume será aluno, não lead.
5. **Imagem chega e o bot fica mudo.** `webhook.js` registra foto, documento e
   vídeo sem responder nada — áudio ao menos ganha um "não consigo ouvir". Isso
   passou a importar quando o roteiro de afastamento passou a pedir foto de
   atestado: o roteiro contorna transferindo antes da foto chegar, mas uma
   resposta curta de confirmação para imagem seria mais barata e evitaria o
   silêncio em qualquer outro caso.

As transcrições **foram lidas em 20/08/2026** — bloco 8 da revisão. O que sair de
lá vira correção; o que ficou pendente está abaixo.

⚠️ **Ao ler transcrições, corte a conversa no primeiro handoff.** A `/teste` não
desliga a IA de propósito, mas o WhatsApp desliga: 31% das respostas do corpus
(37 de 119) descrevem um bot que em produção já estaria pausado.

⚠️ **Referência para comparar rodadas: 78% de handoff** (14 em 18 conversas, até
as mudanças de 20/08). As 3 conversas posteriores não bastam para nada — a
ancoragem nova e a política de descontos ainda não foram exercitadas.

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
negociação de taxa de adesão e marcação de aula experimental), todas parando numa
fila que ninguém olha.

⚠️ **Correção da leitura original:** esses handoffs foram registrados aqui como
"comportamento correto do bot". A auditoria de [REVISAO-PROMPT.md](REVISAO-PROMPT.md)
mostrou que só um deles era — os outros dois são regra do prompt disparando cedo
demais. A negociação da adesão caiu na regra "Financeiro … negociação", que manda
transferir sem tentar resolver, quando o próprio prompt tem a resposta (o Anual é
isento da adesão); e a aula experimental caiu numa instrução que ainda diz
`PENDENTE` para um dado que a base já responde. Ou seja: parte do 3 em 3 é
corrigível no texto, antes de mexer em notificação.

### Ainda não exercitado

O webhook da Evolution está configurado no `docker-compose.yml` (global, com
`BY_EVENTS=false` e o secret na query string), mas **nunca foi testado com uma
instância real**. O fluxo inbound WhatsApp → Evolution → backend continua não
verificado ponta a ponta.

**Loop de restart da Evolution — resolvido em 19/08/2026.** O container ficou
12h reiniciando, e a causa não era a falta de número pareado (a Evolution sobe
com zero instâncias): o Prisma falhava na migração com `P1000`, e por trás dele
o Postgres respondia `role "postgres" is not permitted to log in`. O papel
estava com `NOLOGIN` — não era senha errada. Como o superusuário é o próprio
`postgres`, não havia caminho normal de volta.

Resolvido recriando o volume `apac-ia-sales_postgres_data`, sem perda: eram
65 MB de cluster vazio e o volume `evolution_instances` estava sem nenhuma
instância. A Evolution subiu, roda as migrações e responde 200 em `:8080`.

**Onde parou:** `GET /admin/whatsapp/status` devolve
`The "apacademia" instance does not exist` — que é o erro certo para este ponto,
e prova que backend → Evolution conversa. Falta parear, e aí valem dois
detalhes:

- `EVOLUTION_SERVER_URL` **não está definida** no `.env` da VPS, então vale o
  `localhost:8080` do compose. A Evolution usa essa variável para montar os
  links de QR code e mídia — com `localhost`, o QR não abre de fora. Precisa
  virar `http://108.174.151.51:8080`, e a porta 8080 precisa estar liberada.
- A instância criada tem que se chamar **`apacademia`**, que é o valor de
  `EVOLUTION_INSTANCE` procurado pelo backend.

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
- ~~**Nenhuma data ou hora entra no system prompt**~~ e ~~**o bloco de contato
  desaparece sem nome**~~ — **resolvidos em 20/08/2026.** `buildDynamicContext`
  em `ai-agent.js` monta a camada 3 sempre, com data, dia da semana e hora em
  `America/Sao_Paulo`, e com o contato completo mesmo sem nome. Fica **depois**
  do `cache_control`: antes do breakpoint a hora invalidaria o cache a cada
  minuto.
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
