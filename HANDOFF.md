# Estado do projeto — handoff

> **Snapshot de 22/08/2026, fim do dia.** Documento de continuidade: descreve
> onde o projeto parou e o que a próxima sessão deve fazer.
> Para o plano original, ver [implementation_plan.md](implementation_plan.md).
> Para os achados de prompt e base — aplicados e pendentes — ver
> [REVISAO-PROMPT.md](REVISAO-PROMPT.md).

## Comece por aqui — 23/08/2026

**O dia 22/08 fez o CRM inteiro e ligou a Leia ao EVO.** Painel do consultor com
funil, conversas, simulador e ajustes; agendamento de aula experimental
conduzido pela própria Leia; e a régua de follow-up que recupera quem some.
Dezenove commits no branch `crm-painel`, tudo no ar e exercitado contra a conta
de produção.

**O WhatsApp está conectado e atendendo.** 175 mensagens nas primeiras 6 horas.

**Cinco coisas para saber antes de tocar em qualquer coisa:**

1. **A URL mudou.** O painel é **`https://crm.apacademia.com.br`**. O subdomínio
   `leia` foi descartado — DNS, vhost e certificado (backup do conf em
   `/root/leia.conf.removido-2026-08-22`). A `/teste` agora vive dentro do
   painel, na aba Simulador.
2. **✅ Migrations 002 e 003 aplicadas**, primeiro admin criado
   (`leandro.caminha@gmail.com`). Se o login um dia responder "e-mail ou senha
   incorretos" para uma senha que você sabe estar certa, olhe o log do boot:
   tabela do CRM inacessível produz exatamente esse sintoma.
3. **✅ `EVO_DRY_RUN=false`** desde 22/08 à noite. As escritas no EVO **valem de
   verdade** — cadastro de prospect, agendamento e venda. O painel só mostra a
   fita âmbar quando o ensaio está ligado; sem fita, é produção.
4. **⚠️ Quatro workers rodando.** Fila (5s), sync do EVO (15min), follow-up
   (10min) e o processador de mensagens. O de follow-up **manda mensagem para
   cliente real** — ver a seção própria antes de mexer.
5. **⚠️ O container roda em UTC.** `TZ` não está definida. Toda data lida de
   string precisa de offset **explícito** `-03:00`; sem ele o parse usa o fuso do
   processo e grava 3 horas adiantado. Isso já aconteceu com `experimental_at` e
   foi corrigido em `paraISO()`. **Vale para qualquer código novo.**

### O saldo da API acaba sem aviso prévio

Em 22/08 os créditos da Anthropic zeraram no meio do dia e a Leia parou de
responder — toda mensagem recebida caía no fallback. Desde então a falha da IA
abre handoff com o motivo técnico, em vez de prometer atendimento que não vem,
mas **o sintoma de fundo continua**: sem crédito, não há agente.

Vale um alarme de saldo antes que aconteça de novo num sábado à noite.

### O que foi resolvido em 22/08
### O que foi resolvido em 22/08

**A porta 8080 da Evolution está fechada.** Era a pendência de segurança aberta
em 20/08 — HTTP puro na internet, protegida só pela `AUTHENTICATION_API_KEY`,
com quem tivesse a chave controlando o WhatsApp da academia.

O que destravou fechá-la: **o QR de pareamento agora sai pelo painel**. A
Evolution devolve o QR em `base64` no próprio corpo da resposta de
`/instance/connect`, então quem precisa alcançá-la é o backend, pela
`apac-network` — o navegador do consultor recebe a imagem já pronta. Não é mais
preciso expor a Evolution para parear o número.

Precisando do manager da Evolution, use túnel SSH:

```bash
ssh -p 22022 -i ~/.ssh/aquap_vps -L 8080:localhost:8080 root@108.174.151.51
```

### O WhatsApp ainda não está pareado

A instância `apacademia` continua sem existir na Evolution. O caminho agora é
pelo painel, em **Ajustes → WhatsApp**: *Criar instância* e depois *Gerar QR
code*. O QR expira em ~40 segundos; é só clicar de novo. Precisa de alguém com o
aparelho da academia na mão — não dá para fazer sozinho.

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
| Domínio | **`crm.apacademia.com.br`** — DNS direto para a VPS (sem Cloudflare), nginx terminando TLS |

```bash
ssh -p 22022 -i ~/.ssh/aquap_vps root@108.174.151.51
```

### nginx e TLS — montado em 20/08/2026

A VPS já servia `apacademia`, `aqua` e `pagtos` pelo nginx, com um `.conf` por
subdomínio em `/etc/nginx/conf.d/` e certbot. O `crm.conf` seguiu esse padrão e
faz `proxy_pass` para `localhost:3100`.

O `leia.conf` foi **removido em 22/08/2026**, junto com o certificado dele —
o DNS do subdomínio já não existia, e certificado sem DNS falha a renovação a
cada 12h para sempre. Backup do conf em `/root/leia.conf.removido-2026-08-22`.

| | |
|---|---|
| Certificado | Let's Encrypt para `crm`, expira **20/11/2026**, já no `certbot-renew.timer` |
| Porta 3100 | **só no loopback** (`127.0.0.1:3100:3100` no compose) — nginx é a única entrada |
| Porta 8080 | **fechada no loopback desde 22/08/2026** — o QR sai pelo painel |

⚠️ **Se algum dia precisar emitir certificado para um subdomínio novo que esteja
atrás da Cloudflare:** ela está em **Full (strict)** e fala HTTPS com o origin.
(Não foi o caso do `crm`, cujo registro aponta direto para a VPS — a emissão
funcionou de primeira, com o proxy desligado.) Domínio sem
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
- ✅ `EVOLUTION_SERVER_URL` — **deixou de importar para o QR** em 22/08/2026. O
  painel usa o `base64` do corpo da resposta, não o link montado com essa
  variável. O padrão do compose passou a ser `http://evolution-api:8080`, que é
  o que resolve dentro da `apac-network` para download de mídia.
- ⚠️ `ADMIN_API_KEY` — confira se está preenchida; sem ela `/admin` responde 503

**Armadilha do `env_file`:** uma linha que não seja comentário, vazia ou
`VAR=valor` invalida o arquivo inteiro, e o `docker compose up` aborta **sem
recriar o container** — o sintoma é o serviço antigo continuar no ar como se o
deploy não tivesse acontecido. Aconteceu em 19/08/2026 com uma linha de
separação sem `#`. Para conferir antes de subir (silêncio = válido):

```bash
grep -vnE '^\s*(#|$)|^[A-Za-z_][A-Za-z0-9_]*=' .env
```

## O painel CRM — `crm.apacademia.com.br`

Construído em 22/08/2026. Quatro superfícies, uma autenticação.

| Aba | O que faz |
|---|---|
| **Funil** | A tabela de gestão de leads. Métricas, os dois cartões de pendência, filtros por etapa/dono/origem, ordenação, e a ficha do lead numa gaveta com as ações que escrevem no EVO |
| **Conversas** | Histórico de **todas** as conversas, por id. Abre a thread, responde pelo WhatsApp e devolve para a Leia |
| **Simulador** | Conversar com a Leia sem WhatsApp. Herdeiro da `/teste`, agora amarrado ao consultor logado |
| **Ajustes** | Pareamento do WhatsApp (QR), webhooks do EVO, sincronização e cadastro de consultores |

### Login

**Por consultor, não senha única.** A `/teste` tem senha compartilhada porque é
sala de teste; o painel escreve venda em produção no EVO, e sem autor a tabela do
funil não sabe dizer quem agendou, quem vendeu nem de quem é o lead.

Senha em **scrypt do `node:crypto`** (`src/lib/senha.js`), sem dependência nova —
bcrypt traria compilação de binário ao build do container. Sessão em cookie
assinado, o mesmo mecanismo já validado na `/teste`.

```bash
node scripts/criar-consultor.js --nome "Nome" --email pessoa@ap.com --admin
node scripts/criar-consultor.js --email pessoa@ap.com --senha NovaSenha123  # reset
node scripts/criar-consultor.js --listar
```

Sem `--senha`, uma é sorteada e impressa **uma única vez**. Depois do primeiro
admin, os demais saem por Ajustes → Consultores.

**Trocar a senha, a partir de 23/08/2026, é pelo painel** — o script continua
existindo para o primeiro admin e para quando ninguém consegue entrar:

| Quem | Onde | Precisa da senha antiga? |
|---|---|---|
| A própria pessoa | Botão **Senha**, no cabeçalho | Sim |
| Administrador, para qualquer um | Ajustes → Consultores → **Redefinir senha** | Não |
| Sem ninguém logado | `scripts/criar-consultor.js --email … --senha …` | Não (roda no servidor) |

Mínimo de 8 caracteres nos três caminhos. **Não existe "esqueci minha senha"**:
o hash não volta atrás, e não há e-mail transacional no projeto — quem esquecer
depende de um administrador.

⚠️ **Trocar a senha não derruba sessão já aberta.** A sessão é cookie assinado
sem store (ver `crm-auth.js`): não há o que invalidar sem trocar o segredo, o
que desconectaria todo mundo. Para senha realmente vazada, o caminho é
desativar a conta — `exigirLogin` relê o usuário a cada requisição, então
`active = false` corta o acesso na hora.

A senha atual é conferida com **403, não 401**: o painel trata 401 como "a
sessão morreu" e volta para o login. Errar a digitação não pode deslogar
ninguém.

### Os dois cartões de pendência

Logo abaixo dos números do funil, e eles **mudam de cor** — âmbar quando alguém
entra na fila, vermelho quando o mais antigo passa de 30 minutos. O buraco que
fechavam era antigo: a Leia abria o handoff, calava o bot e **ninguém era
avisado**; o lead ficava em `aguardando_consultor` até alguém abrir a aba certa
por acaso.

| Cartão | Quem entra | De onde sai a conta |
|---|---|---|
| **Aguardando consultor** | Handoff aberto, ninguém assumiu | Leads em `aguardando_consultor`, por `stage_since` |
| **Consultor — contatos aguardando resposta** | Já tem consultor, e o cliente falou por último | Conversa `human` cuja **última mensagem** é `inbound` |

**Os dois particionam a fila, não se sobrepõem** (`src/services/atendimento.js`):
a segunda conta ignora quem ainda está na primeira. A mesma conversa aparecendo
nos dois faria o consultor contar duas vezes o mesmo problema.

A segunda não sai de `wa_conversations.status`: `human` só diz que o bot está
calado, não quem falou por último. Quem responde isso é a direção da última
mensagem — daí a leitura de `wa_messages`, em **uma** consulta para todas as
conversas (janela a partir da conversa parada há mais tempo), e não uma por
conversa.

Clicar no cartão abre a lista de quem está esperando, em ordem de espera: a
fila de handoff leva à ficha do lead, a de resposta leva direto à conversa. O
painel recontabiliza a cada minuto, e só com a aba à vista.

### As etapas do funil

```
novo → em_conversa → aguardando_consultor → com_consultor
     → experimental_agendada → experimental_realizada → ganho | perdido
```

**Etapa é consequência, não campo.** Ninguém marca "em conversa" — o lead está
lá porque chegou mensagem. Ninguém marca experimental agendada — ela está porque
o EVO aceitou o agendamento. Cada avanço grava um evento em `crm_lead_events`
dizendo quem causou e por quê.

Isso não foi preferência de desenho: **nos 50 prospects mais recentes do EVO,
`currentStep` está null em 100% e `temperature` vazio em 100%.** Espelhar o EVO
teria espelhado campo em branco. O funil que depende de alguém arrastar cartão é
exatamente o que já não funciona nesta academia.

Os gatilhos automáticos (`funil.aoReceberMensagem`, `aoAbrirHandoff`,
`aoConsultorAssumir`) usam `somenteAvanco: true` — nunca retrocedem nem reabrem
lead fechado. Só o consultor, pelo painel, pode puxar para trás: é ele quem sabe
que a pessoa desistiu depois de agendar.

⚠️ **Todas as chamadas de funil no fluxo do WhatsApp passam por `moverFunil()`,
que engole exceção.** O funil é observação, não caminho crítico: se o Supabase
engasgar na hora de gravar a etapa, a mensagem do cliente ainda tem que ser
respondida.

### Tabelas novas (migration 002)

| Tabela | Papel |
|---|---|
| `crm_users` | Consultores, com hash de senha |
| `crm_leads` | A linha do funil. **Desnormalizada de propósito**: experimental, venda e última atividade em colunas próprias, para a tela mais aberta do painel responder com um SELECT só |
| `crm_lead_events` | O razão: toda mudança de etapa, escrita no EVO e ação de consultor |
| `crm_evo_webhook_events` | Envelope cru do EVO, guardado antes de interpretar, para reprocessar sem depender de reentrega |
| `crm_evo_poll_state` | Estado do poller |

Duas UNIQUE parciais que valem conhecer: um contato do WhatsApp tem no máximo
**um** lead aberto (fechados podem se acumular — quem cancelou ano passado e
voltou é lead novo), e um `evo_id_prospect` não se repete.

⚠️ **Auto-expose de tabelas está desligado neste projeto.** O bloco 9 da migration
(GRANTs para `service_role`) não é opcional — sem ele a API responde `PGRST205`,
que parece migration não aplicada e não é.

## A integração com o EVO

### O client foi reescrito

`src/services/evo-client.js` foi refeito contra o [swagger
oficial](https://evo-integracao-api.w12app.com.br/swagger/v1/swagger.json),
conferido em 22/08/2026. **Três caminhos estavam errados** e só falhavam em
runtime:

| Estava | É |
|---|---|
| `/api/v1/services` | `/api/v1/service` — singular. O plural é 404 |
| `/api/v1/members` | `/api/v2/members` |
| `POST /api/v1/members` para criar prospect | `POST /api/v1/prospects`. O antigo criava **membro** |

O terceiro era o motivo de `cadastrar_prospect` estar em `PAUSED_TOOLS`.

⚠️ **`POST /api/v1/activities/schedule/experimental-class` recebe tudo por QUERY
STRING.** Não tem corpo. Mandar JSON no body devolve 400 sem dizer por quê.

⚠️ **O campo de atividade inativa é `inactive`, não `isActive`.** Filtrar por
`isActive !== false` deixa passar tudo, porque o campo não existe — e aí plano
desativado é oferecido ao cliente.

### O que os webhooks do EVO cobrem — e o que não cobrem

Eventos assinados: `NewSale`, `RecurrentSale`, `CreateMember`,
`CreateMembership`, `ActivityEnroll`, `TransferProspect`.

⚠️ **Não existe evento de mudança de etapa ou status de prospect no EVO.** A lista
completa da doc é de criação e alteração de membro, contrato, produto, serviço,
venda, matrícula em atividade e transferência — nada sobre a evolução da
oportunidade. Por isso o funil também depende do **poller**
(`evoSync.sincronizarProspects`), que é o que enxerga o que o consultor faz
dentro do EVO. Hoje ele roda sob demanda, por Ajustes → Sincronizar prospects;
**ainda não está agendado**.

O envelope que o EVO manda é enxuto — `{ IdW12, IdBranch, IdRecord, EventType,
ApiCallback }`. O dado real está atrás do `ApiCallback`, que é outra chamada
HTTP. Por isso `/webhook/evo` responde na hora e processa depois: fazer a segunda
chamada dentro da requisição faria o EVO esperar por nós e reentregar por timeout.

⚠️ **O `ApiCallback` é validado contra o host do EVO antes de ser seguido.**
Seguir URL arbitrária vinda de webhook é SSRF, e este processo alcança a rede
interna do Docker.

Registrar os webhooks: Ajustes → Webhooks do EVO → **Registrar**. É idempotente.
Depende de `EVO_WEBHOOK_SECRET` estar no `.env` — sem ele `/webhook/evo` responde
503 (fail-closed, porque o endpoint escreve no funil).

### ⚠️ "Presente" é o valor PADRÃO do EVO, não uma afirmação

Todo participante de uma sessão nasce com `status: 0` (Attending). Ler isso como
presença confirmada faz a Leia perguntar "como foi a aula?" para quem não
apareceu — e não existe desfazer para essa mensagem.

O que é evidência de verdade:

| Sinal | Confiável? | Por quê |
|---|---|---|
| `falta` / `faltaJustificada` | **Sim, sempre** | Ninguém cai em falta: alguém marcou |
| `presente` + sessão finalizada **antes das 22h** | **Sim** | Quem fechou foi gente |
| `presente` + sessão **não** finalizada | Não | É só o default |
| `presente` + finalizada, observada **depois das 22h** | Não | Pode ter sido a finalização automática da meia-noite |

⚠️ **A API não expõe timestamp de finalização** — conferido no swagger e nos
payloads, existe só `status: 6 / Finalized`. Então a evidência é **o momento em
que observamos**: ver "Finalized" enquanto ainda são menos de 22h do dia da aula
prova que alguém fechou antes do processo automático.

É por isso que o worker de follow-up reconsulta de 3 em 3 horas enquanto a
sessão estiver aberta, e desiste às 22h — depois disso a finalização deixa de
significar presença. Sem evidência, a Leia pergunta em vez de afirmar.

Isso também cobre a cautela com prospect: sem finalização humana, um prospect
"presente" volta como `desconhecida`.

### ⚠️ Permissões do token do EVO — três escritas estão bloqueadas

Levantado em 22/08/2026 por sondagem com dados inválidos de propósito
(403 = sem permissão; 400 = tem permissão e o EVO só recusou o dado —
nada foi criado).

| Endpoint | Situação |
|---|---|
| `POST /api/v1/webhook` | ❌ **403** — sem permissão |
| `POST /api/v2/sales` | ❌ **403** — sem permissão |
| `POST /api/v1/notifications/prospect` (follow-up) | ❌ **403** — sem permissão |
| `PATCH /api/v1/prospects` | ✅ permitido |
| `POST /api/v1/prospects/convert` | ✅ permitido |
| `POST /api/v1/activities/schedule/experimental-class` | ✅ permitido |
| Todos os `GET` usados pelo painel | ✅ permitidos |

⚠️ **`POST /api/v1/prospects` (criar prospect) não foi sondado**, porque a
única forma seria criar um prospect de verdade — não há DELETE. O `PATCH` da
mesma família está liberado, o que é um bom sinal, mas **não é prova**: a
permissão do EVO é por endpoint, não por família.

**Não é chamado com a W12 — é auto-serviço.** No EVO, em **Configurações →
Integrações**, expanda a chave de integração e marque os endpoints. A doc de
permissões diz que todo endpoint da API Reference pode ser habilitado ali.

Enquanto essas três não forem liberadas:

- **Webhooks não podem ser registrados** — o funil não recebe venda nem
  conversão por push. O poller cobre parte disso, mas só a parte de prospect.
- **Registrar venda pelo painel falha** com 403.
- **Follow-up no EVO falha** com 403.

O agendamento de experimental e o cadastro de prospect (provavelmente)
funcionam.

### O que o `EVO_API_TOKEN` da VPS era

Até 22/08/2026 o `.env` da VPS tinha o **placeholder** `cole-aqui-o-token-evo`
no lugar do token. Nunca funcionou de lá — passou despercebido porque as tools
do EVO estavam pausadas e nada na VPS chamava a API. Corrigido no mesmo dia,
com backup em `.env.bak-token-2026-08-22`.

Vale como alerta geral: **o `setup-vps.sh` copia o `.env.example`**, e valor de
exemplo que não é substituído fica esperando o dia em que alguém finalmente usa
aquela integração.

### O modo ensaio

`EVO_DRY_RUN=true` faz cadastro de prospect, agendamento e venda **não saírem**
para o EVO: são registrados no log e devolvem `{ dryRun: true }`, e o funil anda
igual. Leitura continua real nos dois modos.

Existe porque **não há filial de testes na conta** — toda escrita é produção. O
painel mostra uma fita âmbar no topo quando está ligado, para ninguém achar que
vendeu e a venda não existir.

**A VPS está com `EVO_DRY_RUN=true`.** Para valer de verdade, troque no `.env` e
recrie o container.

## Follow-up de venda — a régua que recupera quem some

O agente só roda quando chega mensagem: um `messages.create` por mensagem
recebida, sem agendador. Consequência que valeu meses de silêncio: **quem some,
some sem que ninguém saiba**, e nenhuma regra de prompt recupera essa conversa,
porque não existe turno em que o modelo possa agir.

`workers/followup-worker.js` é esse turno.

| Quando | Tipo | O que faz |
|---|---|---|
| 24h antes da aula | `ae_lembrete_24h` | Confirma presença, reforça o valor, diz o que levar |
| 4h depois da aula | `ae_pos_aula` | **Consulta presença no EVO** e conversa de acordo |
| +2 dias | `sondagem_1` | "O que falta para você decidir?" |
| +4 dias | `sondagem_2` | Última, porta aberta |
| +5 dias sem resposta | — | Lead vira `perdido` explícito |

### Três decisões que não são detalhe

**A mensagem é gerada no envio, não guardada no agendamento.** Ela depende de um
fato que só existe depois: se a pessoa compareceu. Texto pronto produziria "como
foi a aula?" para quem faltou, e essa mensagem não tem desfazer.

**A instrução que orienta cada mensagem NÃO entra no histórico.** Vai como turno
de usuário marcado com `[INSTRUÇÃO INTERNA DO SISTEMA]`, orienta aquele turno e
some. Gravá-la criaria uma fala falsa do cliente em todas as conversas
seguintes.

**Três cancelamentos**, e a diferença entre eles importa:

- Lead que fechou ou foi perdido → cancela **tudo**. Fica em `mudarEtapa`, que é
  o caminho comum de painel, webhook do EVO e poller.
- Cliente que responde → cancela **só as sondagens**. O lembrete da aula
  depende da aula, não do silêncio.
- Conversa que o consultor assumiu (`status = human`) → nada é enviado. Quem
  fala é ele.

### A janela de 9h–20h30

Toda mensagem que parte da academia respeita a janela. `dentroDaJanela()` empurra
o que cai fora: antes das 9h vai para as 9h do mesmo dia; depois das 20h30 vai
para as 9h do dia seguinte. Testado em virada de dia e de mês.

Efeito visível: aula na segunda às 6h45 teria lembrete no domingo às 6h45 — ele
sai domingo às 9h.

### O que ainda não existe

O **pós-venda** (D+1 a D+300, renovação a D-30) foi desenhado mas não
implementado. Quando for, vale prompt separado — o maquinário de venda (âncora
de preço, matriz de objeções) é ativamente nocivo numa conversa de retenção, e
54 mil caracteres com a ressalva "mas se já for cliente, não venda" vazam. A
infra já suporta: `loadPrompt(slug)` e `processMessage({ promptSlug })` são
parametrizados.

⚠️ **Não unificar o banco com o AQUAP sem resolver o isolamento antes.** Os
projetos foram separados de propósito, e o motivo está registrado: o anon key
público do AQUAP vai no bundle do Next.js e não pode alcançar conversa de
cliente.

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
| URL | **substituída pela aba Simulador do painel**, em `https://crm.apacademia.com.br`. A rota `/teste` continua no código, mas sem domínio próprio |
| Senha | `Leia` (única, sem usuário) — troque em `TESTE_SENHA` |
| Canal no banco | `wa_conversations.channel = 'web-test'` |
| Desligar | `TESTE_HABILITADO=false` + restart |

### Subir na VPS

```bash
cd /var/www/apac-ia-sales
git pull
docker compose up -d --build backend
```

Confira em `https://crm.apacademia.com.br/health` antes de mandar o link para o
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
  servida por HTTPS, hoje em `https://crm.apacademia.com.br`. Continua valendo a ressalva da
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

`cadastrar_prospect` e `agendar_aula_experimental` **saíram desta lista em
22/08/2026** e estão ativas.

Bloqueio duplo: além de não ser declarada, `executeTool` recusa executá-la caso o
modelo alucine a chamada.

**Tools ativas desde 22/08/2026:** `transferir_para_humano`, `buscar_cadastro`,
`cadastrar_prospect` e `agendar_aula_experimental`. A Leia conduz o agendamento
da aula experimental do começo ao fim — ver "A integração com o EVO".

## Próxima sessão

### Onde retomar

Tudo o que foi construído em 22/08 está **no ar e funcionando**: migrations
aplicadas, prompt publicado, WhatsApp conectado, quatro workers rodando. Não há
passo de instalação pendente.

O que vale fazer a seguir, em ordem de retorno:

**1. Esvaziar a fila de conversas paradas.** No fim de 22/08, seis das dez
conversas de WhatsApp estavam em `human` — ou seja, com a Leia pausada. Cada uma
espera um consultor. No painel: **Conversas → filtro "Com consultor"**, e
*Devolver para a Leia* nas que já foram resolvidas.

**2. Ver a régua de follow-up rodar pela primeira vez.** Há três leads com aula
marcada e follow-up agendado. As mensagens saem sozinhas — vale acompanhar a
primeira leva e ler o que a Leia escreveu.

**3. O aviso ativo de handoff.** Continua sendo pull: alguém precisa abrir o
painel. O destino (número do consultor, grupo, dono do lead) ficou para o
Leandro decidir. A infra de envio já está pareada.

**4. Alarme de saldo da API.** Ver "O saldo da API acaba sem aviso prévio".

**5. Merge de `crm-painel` para `main`.** A VPS roda o branch. Quando o time
validar, o merge fecha o ciclo.

**6. Pós-venda**, se o funil de venda estiver estável — desenho na seção de
follow-up.

**7. A bateria de testes de prompt que ficou de 20/08.** Agora dá para pedir ao
time, porque o simulador está dentro do painel. Roteiros nunca exercitados:
pedir desconto, reclamar de preço, cancelamento com motivo raso, esquecer um
objeto, não conseguir agendar no FITI, atendimento a PCD.

### Limpeza pendente no EVO (assumida pelo Leandro)

Testes de 22/08 deixaram registros a remover no painel do EVO — sem impacto
financeiro (serviço R$ 0), mas com registro errado:

- Vendas **95003–95006** e sessões **199608–199610** (Priscilla)
- Duas das três reservas do **Dalmario** em 25/08 (15h15, 16h15, 17h15) e as
  vendas **95009, 95011, 95013**

⚠️ Se o horário do Dalmario mudar na limpeza, `crm_leads.experimental_at` e os
follow-ups dele precisam ser ajustados junto — senão ele recebe lembrete do
horário errado.

### O que ainda mexe no resultado e continua pendente

0. ~~**Fechar a 8080 da Evolution**~~ — **resolvido em 22/08/2026.** Fechada no
   loopback; o QR de pareamento passou a sair pelo painel.
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

- ~~`EVOLUTION_SERVER_URL` precisa virar o IP público~~ — **não é mais
  necessário.** Desde 22/08/2026 o QR sai pelo painel a partir do `base64` da
  resposta, e a 8080 está fechada de propósito. Parear é em **Ajustes →
  WhatsApp**, no CRM.
- A instância criada tem que se chamar **`apacademia`**, que é o valor de
  `EVOLUTION_INSTANCE` procurado pelo backend.

## Backlog conhecido (não tratado)

- **Handoff não notifica ninguém** — *melhorou, não fechou.* Desde 22/08 ele vira
  a etapa `aguardando_consultor` no funil, com o tempo parado visível na tabela e
  no cartão "Parados". Mas continua sendo **pull, não push**: alguém tem que
  abrir o painel. Falta o aviso ativo (WhatsApp para o consultor, e-mail, ou som
  na aba aberta).
- **Fila pode travar em `processing`** — se o processo cair após marcar o status,
  a linha nunca volta para `pending` e a query só busca `pending`.
- **O poller do EVO não está agendado** — `evoSync.sincronizarProspects` só roda
  quando alguém clica em Ajustes → Sincronizar prospects. Como é ele que cobre a
  ausência de webhook de mudança de prospect, enquanto não for periódico o funil
  não enxerga o que o consultor faz dentro do EVO.
- **Webhook do EVO sem reprocesso automático** — `evoSync.reprocessarPendentes`
  existe e não é chamado por ninguém. Evento que falhou fica parado.
- **Zero testes commitados** — `npm test` aponta para `src/**/*.test.js`, que não
  existe. Continua valendo, e o CRM aumentou a superfície: o funil tem regras de
  transição (`somenteAvanco`, etapas finais) que são exatamente o tipo de coisa
  que teste unitário pega barato.
- ~~**Evolution na 8080 poderia ser fechada**~~ — **fechada em 22/08/2026.**
- **`ai_enabled` é gravado mas nunca lido** — só `status === 'human'` é checado.
- ~~**Nenhuma data ou hora entra no system prompt**~~ e ~~**o bloco de contato
  desaparece sem nome**~~ — **resolvidos em 20/08/2026.** `buildDynamicContext`
  em `ai-agent.js` monta a camada 3 sempre, com data, dia da semana e hora em
  `America/Sao_Paulo`, e com o contato completo mesmo sem nome. Fica **depois**
  do `cache_control`: antes do breakpoint a hora invalidaria o cache a cada
  minuto.
- **Telefone não é normalizado** antes das buscas no EVO.
- ~~**CORS só lista `localhost`**~~ — `crm.apacademia.com.br` e o curinga
  `*.apacademia.com.br` entraram em `server.js`.

### Fora deste repositório

O arquivo `test-evo-experimental.js` do **AQUAP** tem o token do EVO em texto
puro e commitado. Vale rotacionar.

## Referência: endpoints do EVO

⚠️ **Desatualizado desde 22/08/2026.** A referência viva agora é
`src/services/evo-client.js`, escrito contra o swagger oficial
(`https://evo-integracao-api.w12app.com.br/swagger/v1/swagger.json`, 124
endpoints). A tabela abaixo fica pelo histórico dos erros que ela ajudou a achar.

Levantado por teste direto (`GET` apenas — nada foi escrito em produção).

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
