# Estado do projeto — handoff

> **Snapshot de 28/08/2026, fim do dia.** Documento de continuidade: descreve
> onde o projeto parou e o que a próxima sessão deve fazer.
> Para o plano original, ver [implementation_plan.md](implementation_plan.md).
> Para os achados de prompt e base — aplicados e pendentes — ver
> [REVISAO-PROMPT.md](REVISAO-PROMPT.md).

## ⚠️ Antes de qualquer coisa — 28/08/2026

**Duas coisas mandam mensagem para cliente real sozinhas, agora.**

**1. Campanha `aqua-inativos-dez24-jun25`** — 64 alvos, teto de 40/dia,
`CAMPANHA_DRY_RUN=false`. Em 28/08 foram 40 agendados; 24 seguem pendentes.
(A `aqua-anual-2026` está `concluida`: 45 entregues, **37,8% de resposta**, zero
supressões.)

**2. Régua de silêncio** — cutuca lead que parou de responder, 2 e 4 dias após a
nossa última fala. Varredura de hora em hora, teto de 15 por varredura.

Tudo respeita a janela de contato: seg–sex 9h–20h30, sáb 9h–13h, **domingo nunca**.

```bash
# ver
docker compose exec backend node scripts/campanha.js status
# parar a campanha
docker compose exec backend node scripts/campanha.js pausar <slug> "motivo"
```

`pausar` impede NOVOS agendamentos mas **não cancela o que já está na fila**.
Para estancar tudo: `docker compose stop backend` — a fila para junto.

**Parar a régua de silêncio** tem a mesma armadilha, e pior: pôr
`FOLLOWUP_SILENCIO_HABILITADO=false` só impede varreduras novas — **o que já
está agendado sai assim mesmo**. Para estancar de verdade:

```sql
UPDATE crm_followups SET status = 'cancelado', erro = 'parado à mão'
WHERE tipo IN ('silencio_1','silencio_2') AND status = 'pendente';
```

Cancelar não queima a rodada: a varredura só é bloqueada por `pendente` e
`enviado`, então essas pessoas voltam a ser elegíveis quando você quiser.

**Mudança de comportamento que a equipe precisa saber:** desde hoje, consultor
que escreve pelo **celular** põe a conversa em modo humano e a Leia cala até
alguém **reativar no painel**. Antes ela retomava sozinha.

---

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
   (10min, com a varredura de silêncio de 60 em 60min dentro dele) e o
   processador de mensagens. O de follow-up **manda mensagem para cliente
   real** — ver a seção própria antes de mexer.
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

> ⚠️ **Esta seção descrevia o projeto em 19/08 e ficou para trás.** Dizia que o
> agente não escrevia em sistema nenhum e que o WhatsApp nunca tinha sido
> conectado — as duas coisas deixaram de ser verdade em 22/08. Reescrita em
> 28/08/2026; o histórico de como se chegou aqui está nas seções "O que foi
> feito em `<data>`".

**O sistema está em produção, atendendo cliente real pelo número principal da
academia.** WhatsApp conectado, painel do consultor no ar em
`crm.apacademia.com.br`, e a Leia **escreve no EVO**: cadastra prospect, agenda
aula experimental e registra venda.

Cinco automações mandam mensagem sozinhas, e todas respeitam a janela de contato:

| | |
|---|---|
| Atendimento | responde quem escreve, com debounce de 12s |
| Follow-up da aula | lembrete 24h antes, conversa 4h depois |
| Régua de silêncio | 2 e 4 dias sem resposta, para lead que sumiu |
| Campanha ativa | coorte do EVO, teto por campanha |
| Fila dos apps irmãos | cobrança, nota fiscal |

**Fase atual: operação medida.** O piloto de campanha fechou com 37,8% de
resposta e zero supressões em 45 disparos. O que falta não é construir, é
observar: a régua de silêncio rodou pela primeira vez em 28/08 e ninguém leu
ainda o que a Leia escreveu nessas retomadas.

⚠️ **A bateria de testes de prompt de 20/08 continua pendente** — pedir desconto,
reclamar de preço, cancelamento com motivo raso, esquecer um objeto, não
conseguir agendar no FITI, atendimento a PCD. Agora dá para pedir ao time, porque
o simulador está dentro do painel.

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

## A ramificação do funil — venda x relacionamento

Criada em 31/08/2026. Migrations **009** e **010**.

⚠️ **As duas rodam ANTES do deploy do código, nesta ordem.** A 009 só adiciona o
rótulo `finalizado` ao enum `crm_stage`, sozinha, porque o Postgres proíbe usar
um rótulo novo na mesma transação em que ele foi criado — e a 010 o usa em
índice parcial. Código no ar sem as colunas derruba a tela do funil com
`column crm_leads.trilha does not exist`.

`garantirLeadDoContato` abre uma linha em `crm_leads` para **todo** contato que
escreve, e o número é o principal da academia. Até aqui todos corriam no mesmo
funil de venda: quem quer comprar, o aluno perguntando o horário da natação, o
cliente de convênio, o fornecedor de toalha e o vendedor de software. O efeito
não é cosmético — é que a leitura do painel deixa de valer:

- **"Leads abertos"** conta aluno matriculado.
- **"Parados há 2+ dias"** conta o fornecedor que nunca teve o que responder.
- **A conversão** sai dividida por um denominador cheio de gente que nunca
  esteve comprando.

### As duas trilhas

| `trilha` | Etapas | Para quem |
|---|---|---|
| `lead` | novo → em conversa → aguardando/com consultor → experimental → **ganho/perdido** | Quem quer conhecer, contratar ou voltar a treinar |
| `relacionamento` | em conversa → aguardando/com consultor → **finalizado** | Aluno, convênio/agregador, fornecedor, e o resto |

As três primeiras etapas são as **mesmas** nas duas: chegar mensagem, abrir
handoff e o consultor assumir acontecem igual dos dois lados, e são os mesmos
gatilhos que movem. O que muda é o fim da linha.

`finalizado` não é `ganho` nem `perdido` de propósito: os dois entram na
conversão, e responder o horário da natação para um aluno não é venda ganha nem
venda perdida.

### Quem decide, e onde fica gravado

| Quem | Como |
|---|---|
| A Leia | tool `definir_tipo_atendimento`, assim que a conversa deixa claro com quem ela fala |
| O consultor | gaveta do lead → Ações → **Tipo de atendimento** |
| A varredura de follow-up | ao descobrir no EVO que o "lead" tem contrato ativo, grava `aluno` |
| `mudarEtapa` | ao fechar uma venda (`ganho`), marca o contato como `aluno` |

**O tipo mora no CONTATO (`wa_contacts.tipo_contato`), a trilha mora na linha.**
São perguntas diferentes: "este número é de um aluno" é permanente e vale para o
próximo atendimento dele; "este atendimento é de venda" vale para esta linha.
Sem a memória no contato, o mesmo aluno voltaria a nascer como lead toda vez que
abrisse conversa.

⚠️ **Linha fechada não é reclassificada.** Um lead `ganho` continua `ganho` na
trilha de venda para sempre, mesmo depois de a pessoa virar aluna — senão a
venda some da conversão no dia seguinte ao fechamento. A classificação nova vale
para o contato e para o próximo atendimento.

**O caminho de volta existe e é automático.** Se um fato de venda cair numa
linha de relacionamento (o aluno agendou experimental de outra modalidade, ou
comprou mais um plano), `mudarEtapa` devolve a linha à trilha de venda, com
evento no razão. Recusar a etapa esconderia uma venda de verdade do funil.

### O que a ramificação muda no follow-up

A régua de venda passou a filtrar `trilha = 'lead'` **na consulta**, e não só no
fim do laço. Antes, a única defesa era `situacaoComercial()` — uma ida ao EVO
por lead candidato, na última linha da varredura. Ela continua lá, para quem
ninguém classificou ainda, mas quem já é conhecido nem entra na lista:

- menos chamada ao EVO por varredura;
- o worker confere a trilha **de novo** antes de enviar, porque entre o
  agendamento e o envio passam horas — e é nesse intervalo que a Leia descobre
  que o "lead" é o fornecedor;
- `encerrarSemResposta` não marca `perdido` fora da trilha de venda: quem não é
  venda não é venda perdida.

### Como um atendimento de relacionamento termina

Sozinho, por inatividade — `RELACIONAMENTO_DIAS_FINALIZAR`, padrão **3 dias**,
0 desliga. Roda no ciclo do worker de follow-up, não manda mensagem nenhuma e
só toca a trilha de relacionamento.

Existe porque ninguém volta ao painel para encerrar a conversa de quem perguntou
o horário e foi treinar. Sem prazo, a coluna CONVERSAS só cresce — e painel que
nunca esvazia é painel que ninguém olha. Escrevendo de novo, a pessoa abre um
atendimento **novo**, na mesma trilha (o tipo mora no contato): cada assunto é
um atendimento, que é o que se quer contar.

## Follow-up de venda — a régua que recupera quem some

O agente só roda quando chega mensagem: um `messages.create` por mensagem
recebida, sem agendador. Consequência que valeu meses de silêncio: **quem some,
some sem que ninguém saiba**, e nenhuma regra de prompt recupera essa conversa,
porque não existe turno em que o modelo possa agir.

`workers/followup-worker.js` é esse turno.

São **duas réguas**, disjuntas por construção.

**Régua da aula** — para quem marcou experimental. Nasce do agendamento:

| Quando | Tipo | O que faz |
|---|---|---|
| 24h antes da aula | `ae_lembrete_24h` | Confirma presença, reforça o valor, diz o que levar |
| 4h depois da aula | `ae_pos_aula` | **Consulta presença no EVO** e conversa de acordo |
| +2 dias | `sondagem_1` | "O que falta para você decidir?" |
| +4 dias | `sondagem_2` | Última, porta aberta |
| +5 dias sem resposta | — | Lead vira `perdido` explícito |

**Régua do silêncio** — para quem sumiu em qualquer outro ponto do funil: no
meio da conversa, depois de ouvir o preço, depois de um consultor prometer
retorno. Não nasce de fato nenhum, porque silêncio não é um fato: é a ausência
dele, e ninguém emite um evento "o cliente não respondeu". Nasce de uma
varredura (`varrerSilenciosos`).

| Quando | Tipo | O que faz |
|---|---|---|
| 2 dias calada | `silencio_1` | Retoma o assunto onde parou, sem comentar o sumiço |
| +2 dias (4º dia) | `silencio_2` | Última, reconhece que pode não ser o momento |
| +5 dias sem resposta | — | Lead vira `perdido` explícito |

O relógio é a **nossa última fala sem resposta** — da Leia ou do consultor.
Cobrança e campanha (`sent_by` começando com `app:`) não contam: quem não
respondeu a um boleto não é um lead em silêncio, e quem não respondeu à abertura
de campanha tem a porta de consentimento dela.

Não há encadeamento em código entre as duas rodadas: como a própria cutucada
vira a nossa última fala, a mesma regra aplicada duas vezes já produz "2 e 4
dias". O efeito colateral é o desejado — se o consultor responder à mão no dia
3, a mensagem dele reinicia o relógio.

**Por que tipos próprios e não `sondagem_*`:** o índice único é
`(lead_id, tipo) WHERE pendente`, então reaproveitar faria um lead que sumiu
antes da aula colidir com a própria régua pós-aula — e gastar as duas rodadas
dela antes da aula acontecer. Além disso o roteiro mentiria: `sondagem_1` afirma
"você passou pela experiência", e quem está em `silencio_1` pode nunca ter
pisado na academia. A varredura recusa abrir uma régua quando a outra já correu.

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
- Cliente que responde → cancela **as sondagens e as cutucadas de silêncio**. O
  lembrete da aula e a conversa pós-aula ficam de pé: dependem da aula, não do
  silêncio.
- Conversa que o consultor assumiu (`status = human`) → nada é enviado. Quem
  fala é ele.

Cancelar, e não apagar, é o que **devolve a rodada**: a varredura só é bloqueada
por `pendente` e `enviado`, então quem respondeu e sumiu de novo volta a ser
elegível — partindo da rodada em que parou.

### A régua de silêncio não fala com aluno matriculado

`garantirLeadDoContato` abre um lead para **todo** contato que escreve no
WhatsApp, e o número é o principal da academia. Aluno perguntando o horário da
natação vira lead em `em_conversa` igual a quem nunca pisou aqui — e se parasse
de responder, receberia "o que falta para você decidir?".

`is_prospect` não resolve: nasce `true` em `contacts.js` e em `teste.js`, e
**nenhum código o coloca em false**. O mesmo vale para `wa_contacts.evo_member_id`
(0 de 11 contatos em 20/08/2026). Isso já estava documentado em `ai-agent.js`, e
lá a conclusão foi não afirmar nada ao agente. Aqui a conclusão é outra, porque
aqui dá para **perguntar ao EVO**: `situacaoComercial()` resolve o `idMember`
(pelo vínculo do lead ou por telefone) e chama `situacaoDoMembro`.

| Situação | Resultado |
|---|---|
| Sem cadastro de aluno | `lead` — cutuca |
| Contrato ativo | `aluno` — **não** cutuca |
| Parado há menos de `EVO_MESES_REATIVACAO` (3) | `aluno` — não cutuca |
| Parado há mais que isso, ou sem contrato nenhum | `lead` — cutuca |

A definição de "aluno" é a mesma que libera aula experimental. Usar outra aqui
criaria duas definições no mesmo sistema.

⚠️ **Falha fechada.** EVO fora do ar devolve `indefinido` e a cutucada **não**
sai. É a escolha certa entre os dois erros: adiar um lead custa uma hora, porque
a varredura repete; cutucar um aluno pagante custa a relação com ele. Como a
consulta é a única que sai para a rede, ela fica por último — só para quem já
passou por todos os outros filtros.

### Carência de campanha

Quem **recebeu e não respondeu** fica `CAMPANHA_CARENCIA_DIAS` (30) fora das
campanhas seguintes. Não é supressão: quem pede para sair vai para
`crm_supressoes` e não volta. Silêncio quer dizer "agora não", não "nunca".

O filtro é `status = 'enviado'` — como os status dos alvos são exclusivos e quem
responde vira `respondeu`, a consulta já significa "recebeu e ficou calado".

Vale nos **dois** caminhos de entrada, e isso não é redundância: `montarAlvos` é
o caminho do segmento montado aqui, mas a coorte real entra por
`absorverSegmentacao` — a automação do EVO dispara um POST por pessoa e nunca
passa pelo primeiro. Foi assim que as 47 chegaram.

É filtro de **entrada**, como a supressão: quem está em carência não aparece nas
contagens da campanha, senão a taxa de resposta passa a ter no denominador gente
que nunca teve chance de responder.

### Acionar o acumulado à mão

A varredura enxerga `FOLLOWUP_SILENCIO_JANELA_DIAS` para trás (padrão: 7). O
teto existe para o primeiro ciclo depois do deploy não acordar lead de meses
atrás, para quem uma retomada não é retomada, é abordagem fria.

Quem parou antes disso se alcança pelo painel:

```http
POST /crm/api/followups/varredura
{ "janelaDias": 30, "lote": 25, "simular": false }
```

**Simula por padrão.** Sem `"simular": false` explícito nada é gravado: a
resposta lista quem entraria, com quantos dias de silêncio, por qual rodada e a
que horas cada mensagem sairia. É ação em lote sobre cliente real — a ordem
certa é ler a lista antes.

Não existe rotina separada de recuperação porque o critério de dias é um **piso**
(`>= dias`), não uma igualdade: um lead parado há 5 dias que nunca foi cutucado
entra normalmente. É a mesma função, com a janela aberta.

### A janela de contato ativo

Toda mensagem que parte da academia respeita a janela, que **depende do dia**:

| Dia | Janela |
|---|---|
| Segunda a sexta | 9h00 – 20h30 |
| Sábado | 9h00 – 13h00 |
| Domingo | **sem contato** |

`dentroDaJanela()` empurra o que cai fora: antes de abrir, num dia que abre, vai
para a abertura do mesmo dia; fechado ou já encerrado, vai para a abertura do
**próximo dia com contato** — o que faz sábado à tarde saltar o domingo inteiro
e cair na segunda. Testado em virada de dia e de mês.

Sábado e domingo entraram em 28/08/2026. Até então domingo era dia normal, com a
justificativa de que "mandar WhatsApp no domingo de manhã não incomoda ninguém".
A regra da academia é outra, e a janela agora reflete o horário da recepção:
mensagem que a pessoa responde às 16h de sábado não tem quem atenda.

⚠️ A mesma janela vale para a **campanha**. Ela espelhava as constantes num
arquivo próprio; o espelho saiu junto, porque espelho de regra que muda vira
divergência — a campanha espalharia até 20h30 num sábado e o excedente
desabaria todo nas 9h de segunda.

### O lembrete que anda para trás

A regra dos outros follow-ups é empurrar para a frente. O `ae_lembrete_24h` é a
exceção, e precisa ser: 24h antes de uma aula de segunda cai no domingo, e
empurrar para a frente daria "próxima abertura = segunda às 9h" para uma aula
das 9h — o aviso chegando quando a pessoa já deveria estar lá.

A decisão não é "o ideal caiu em dia sem contato?", e sim **"o horário ajustado
ainda avisa com pelo menos 6h de antecedência?"**:

| Aula | Lembrete |
|---|---|
| Segunda, antes das 15h | **Sábado**, na mesma hora (preso a 13h) |
| Segunda, 15h ou depois | Segunda de manhã, 9h |
| Qualquer outro dia | 24h antes, como sempre |

As 6h reproduzem a regra da academia — "segunda a partir das 15h, aviso na
segunda de manhã" — sem escrever as 15h em lugar nenhum: o dia abre às 9h, e
9h + 6h = 15h. Escrita como antecedência em vez de hora de corte, a regra
sobrevive a uma mudança de abertura e cobre sozinha o caso que a hora de corte
deixava passar: aula de **domingo à tarde**, cujo ideal cai no sábado à tarde —
dia com janela, mas fora dela — e que a primeira versão jogava para a segunda,
depois da aula.

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

## O que foi feito em 28/08/2026

A régua de follow-up passou a cobrir quem some **antes** da aula, a janela de
contato ganhou fim de semana, e a campanha ganhou carência. Commits `3d4703e`,
`5d00601`, `8b93540` e `c45136b`, todos no ar.

### Estado no fim do dia

| | |
|---|---|
| Migrations aplicadas | 004, 005, 006, 007 e **008** |
| Deploy | `c45136b`, VPS igual ao repositório |
| Régua de silêncio | **ligada** — 2 e 4 dias, teto de 15 por varredura, a cada 60 min |
| Campanha `aqua-anual-2026` | `concluida` — 46 alvos, 45 entregues, **37,8% de resposta**, 0 supressões |
| Campanha `aqua-inativos-dez24-jun25` | **ATIVA** — 64 alvos, teto 40/dia, 40 agendados em 28/08 |
| Janela de contato | seg–sex 9h–20h30, sáb 9h–13h, **domingo nunca** |
| Monitor de sessão | sonda a cada 2 min; faixa vermelha no painel |

### As quatro coisas que mudaram

**1. Régua do silêncio** (`silencio_1` / `silencio_2`). O follow-up só nascia do
agendamento da experimental; quem parava de responder em qualquer outro ponto
não tinha turno em que alguém agisse. Seção própria acima.

**2. Telefone conferido antes da chamada ao modelo.** O primeiro envio da régua
saiu para `136030220984483`, lixo de cadastro que passava pelo filtro de
`startsWith('teste')`. A mensagem foi gerada e paga antes de a Evolution
responder `exists: false`. `telefoneValido` subiu de `campanhas.js` para
`evolution.js` e passou a valer nos dois caminhos.

**3. Janela de fim de semana**, e o lembrete que anda para trás. Seções próprias
acima. A campanha entrou junto, porque espelhava a janela em constantes próprias.

**4. Guarda de aluno matriculado.** `garantirLeadDoContato` abre lead para todo
contato que escreve, e o número é o principal da academia — aluno perguntando
horário virava lead e receberia "o que falta para você decidir?". Seção própria
acima.

### Campanha: a coorte nova e o que ela ensinou

Os 75 leads mandados do EVO em 28/08 foram **todos rejeitados** no webhook:

```
Segmentação ignorada: nenhuma campanha com evento_gatilho
"Alunos inativos aqua de dez24 a jun25 faixa etarua 27 a 48 a…"
```

O vínculo campanha↔segmento é o **texto da descrição, comparado por igualdade
exata**. Segmento novo = descrição nova = nada casa. Some-se a isso que a
campanha antiga estava `concluida`, e `campanhasAtivas()` só pega `ativa`.

⚠️ **Isto vai repetir toda vez que um segmento novo for montado no EVO.** O
sintoma é mudo do lado de lá: o EVO entrega os POSTs com sucesso e ninguém vê que
o outro lado descartou. Antes de montar segmento novo, criar a campanha com o
`evento_gatilho` **idêntico** à descrição — ou conferir o log depois.

O que salvou foi `crm_evo_webhook_events`: os 75 payloads estavam guardados, e
deu para reprocessá-los por `absorverSegmentacao` sem reenviar nada do EVO. Dos
75: **64 viraram alvo**, **9 caíram na carência** (receberam a campanha de agosto
e não responderam — a regra funcionando no primeiro uso real) e **2 tinham
telefone inutilizável**.

⚠️ Ao copiar uma campanha, **`base_legal` precisa ser reescrita**. A cópia
trouxe "contrato encerrado entre jul e dez/2025", que é a coorte do piloto e não
a desta. É o campo que justifica na LGPD falar com a lista — descrever a lista
errada nele não é detalhe de texto.

### Sobre os 28 da campanha que não responderam

Eles **não estão no funil e não devem entrar**. `campanhas.js` não toca em
`crm_leads`: o disparo cria contato, conversa e a linha em `crm_campanha_alvos`,
e o lead só nasce quando a pessoa **responde**. Foi isso que separou os 17 dos 28.

Não crie lead para marcá-los `perdido` — infla o denominador da conversão com
gente que nunca se engajou, e a taxa passa a medir a qualidade da lista fria em
vez do atendimento. O registro honesto deles já existe, e está no lugar certo:
`crm_campanha_alvos.status = 'enviado'` sem nunca ter virado `respondeu`.

O que dá para limpar é a **lista de conversas**, não o funil:

```sql
UPDATE wa_conversations SET status = 'closed', closed_at = NOW()
WHERE status = 'active' AND contact_id IN (
  SELECT c.id FROM wa_contacts c
  JOIN crm_campanha_alvos a ON a.phone = c.phone
  WHERE a.status = 'enviado' AND a.campanha_id = 2
);
```

Reversível: se alguma delas escrever meses depois, `getOrCreateConversation` abre
outra e o fluxo normal — inclusive a criação do lead — acontece.

### A queda do WhatsApp, às 16:43

A sessão caiu e **ficou 2h30 fora sem ninguém notar**. O container estava de pé
e a Evolution respondia HTTP 200 em 0,29s — o que tinha morrido era o pareamento:

```
{"instance":{"instanceName":"apacademia","state":"close"}}
```

⚠️ **O pior não é o envio, é a entrada.** A última mensagem recebida foi às
19:43:25 UTC, no segundo exato da queda. Por 2h30 ninguém conseguiu falar com a
academia — e não dá nem para saber quem tentou.

Três coisas saíram disso, todas implementadas:

**Monitor de sessão** (`whatsapp-monitor.js`), sondando de 2 em 2 min. O aviso
sai no log e numa faixa vermelha no topo do painel. **Não sai por WhatsApp**, de
propósito: mandar aviso pelo canal que caiu é o erro clássico de monitoração, e
aqui seria total — a mensagem entraria na fila e falharia com "Connection
Closed". O estado vai pendurado em `/api/atendimento/pendencias`, que todo painel
aberto já consulta de minuto em minuto. É pull, mas troca 2h30 por 1 minuto.

`desconhecido` é distinto de `close`: significa que a Evolution não respondeu. O
painel diz isso em vez de afirmar que o WhatsApp caiu — são problemas diferentes,
e confundi-los manda alguém parear um QR à toa.

**QR liberado para todo consultor.** Era `exigirAdmin`. Com a sessão caída a
academia inteira fica muda, e quem está na recepção com o celular na mão não
podia religar sozinho. Restrição que atrasa o conserto de uma parada total
protege menos do que custa — e escanear exige o celular pareado, que é a
credencial de verdade. Criar/recriar instância continua admin: essa apaga o
pareamento.

**Duas armadilhas de recuperação**, para a próxima vez:

1. `RATE_LIMIT_MS = 1_000` na fila. As mensagens que venceram durante a queda
   saem **a 1 por segundo no instante da reconexão** — 22 disparos em 22s de um
   número que acabou de voltar, que é o padrão que mais gera bloqueio.
   **Reespace a fila ANTES de parear.**
2. O alvo de campanha guarda o erro genérico `"a fila não conseguiu entregar"`,
   idêntico para qualquer causa. O erro específico mora na linha de
   `wa_message_queue`. Devolver à fila filtrando pelo erro do alvo devolve junto
   quem falhou por `exists: false` — número que não existe no WhatsApp, e que vai
   falhar de novo. **Filtre pelo erro da fila, não pelo do alvo.**

### A cota do EVO: 5 chamadas por segundo

`429 API calls quota exceeded! maximum admitted 5 per 1s`. Apareceu pela
primeira vez em 28/08/2026, e **nada no cliente respeitava esse limite**:
`sincronizarProspects` percorre os leads num laço `await` apertado, e laço local
faz dezenas de chamadas por segundo sem esforço. A guarda de aluno ativo da régua
de silêncio somou mais 1–2 chamadas por lead varrido e o teto estourou.

O espaçamento ficou em `evoFetch`, **não em cada laço**: o limite é da conta
inteira, e throttle por chamador não sabe do outro — dois laços educados somam
10/s. 250ms entre chamadas = 4/s, com folga deliberada. O poll de 15 leads passa
de instantâneo para ~4s, irrelevante num worker de 15 min.

⚠️ **Reenvio só em GET.** `evoFetch` atende leitura e escrita pelo mesmo caminho,
e repetir o POST que cria prospect, agenda aula ou registra venda criaria dois. Um
429 numa escrita sobe para o chamador, que sabe se pode repetir — este helper não.

O campo `EvoApiError.retryable` existia desde sempre e **nunca foi usado por
ninguém**. Cada 429 era um lead que o poll deixava de reconciliar em silêncio.

### O relógio da varredura, agora persistido

`ultimaVarredura` era `let … = 0` em memória, e memória zera no boot: **cada
deploy disparava uma varredura nova**. Medido no próprio 28/08 — três deploys,
três varreduras, ~45 cutucadas onde a régua promete 15/hora.

O marcador foi para `crm_controle` (migration **008**), uma tabela chave-valor
para exatamente este tipo de coisa. O carimbo vem **antes** da varredura, não
depois: se ela falhar no meio, o certo é esperar o próximo intervalo — varredura
que falha costuma falhar de novo, e insistir a cada 10 min só multiplica o efeito
de um EVO fora do ar.

`controle.js` falha **aberta**: se a leitura do marcador não responder, o worker
roda a varredura em vez de travar. O pior caso é uma varredura a mais, que o teto
de lote limita; travar a régua inteira porque uma tabela auxiliar não respondeu
seria pior. Efeito colateral útil: **sem a migration 008, o comportamento é
exatamente o antigo** — nada quebra, só não persiste.

## O que foi feito em 25/08/2026

Dia longo. Campanha ativa no ar, dois bugs de produção corrigidos, prompt
aparado e a Leia passou a ouvir áudio. Commits de `17a3ebf` a `9915cda`.

### Estado no fim do dia

| | |
|---|---|
| Migrations aplicadas | 004, 005 e **006** |
| Deploy | `9915cda`, VPS igual ao repositório |
| Campanha `aqua-anual-2026` | **ATIVA e disparando** — 46 alvos, 19 agendadas, 1ª enviada 16:15 |
| `CAMPANHA_HABILITADA` / `DRY_RUN` | `true` / `false` — mensagens saem para cliente real |
| Transcrição de áudio | ligada (Groq), testada com áudio real |

### A campanha, e o que o EVO revelou

O webhook de automação do CRM do EVO é **outro sistema** do webhook da API
(`/api/v1/webhook`). Não tem lista de eventos: o webhook é uma AÇÃO dentro de
uma automação montada na tela, e o `eventType` sai do que a automação faz.
Não adianta procurar catálogo — não existe.

O primeiro disparo real trouxe `crm.segmentation.batch`: **47 pessoas em 2,6
segundos**, um POST por pessoa, com telefone (46 são celular válido),
`idMember` e um **link de checkout tokenizado por pessoa**. Esse link não se
recupera depois — nenhuma API do EVO o devolve. Perder o evento é perder o
link.

O `eventType` é o MESMO para todo segmento. Quem distingue é o texto de
`communication.message`, a descrição escrita na tela do EVO — e é por ela que
a campanha é encontrada (`crm_campanhas.evento_gatilho`). **Renomear o
segmento no EVO quebra o vínculo.**

`communication.message` **não é mensagem para o cliente**. Veio como "alunos
inativos que tinham contrato aqua que venceu entre jul e dez de 2025" — o
filtro, uso interno. Enviá-lo contaria às pessoas por qual critério foram
escolhidas. O prompt proíbe por escrito.

### A abordagem tem duas mensagens

A abertura só pede licença. A oferta só vai para quem aceitou. Interpretar
esse "sim" com o prompt de vendas inteiro custaria ~48.000 tokens para ler
três letras, então sim e não são resolvidos na **porta de consentimento**
(`tratarConsentimentoDeCampanha` em `webhook.js`), sem acordar o agente.

A porta falha para o lado seguro: frase longa é sempre "outro" e cai no
agente, mesmo começando com "sim".

Recusa encerra e marca o funil, **sem handoff** — 47 recusas virariam 47
pendências numa fila que já tem gente esperando.

### Dois bugs de produção, achados e corrigidos

**1. Nenhum `ApiCallback` do EVO era seguido.** A guarda anti-SSRF comparava
com `config.evo.baseUrl`, e o EVO chama de volta por OUTRO domínio:
consultamos `evo-integracao-api`, ele responde `evo-integracao` (sem o
"-api"). Sintoma mudo — venda chegava, detalhe nunca era buscado, lead não
fechava. Agora confere contra `config.evo.callbackHosts`, uma allowlist.

Junto: nem todo `ApiCallback` vem interpolado. O de `CreateMember` chega como
`/api/v1/members/{idMember}`, literal. A troca usa o `IdRecord` e é feita na
string crua — `new URL()` percent-encoda as chaves.

**2. Agendar aula experimental REGISTRA UMA VENDA no EVO.** O serviço "AULA
EXPERIMENTAL" (idService 6, `experimentalClass`) é vendido por R$ 0 a cada
trial, inclusive quando quem marca é a Leia. `NewSale` dispara para
agendamento, não só para venda.

Ao reprocessar os 88 eventos guardados, **8 leads foram para "ganho" e 8
follow-ups futuros foram cancelados** — um deles dispararia naquela noite.
Ninguém tinha comprado. Revertido a partir de `crm_lead_events`, sem perda. O
handler agora confere o `idService` antes de fechar.

**Conclusão que isso derruba:** a conversão WhatsApp para matrícula ainda é
**zero**. As 43 `NewSale` são trials e vendas de balcão.

### A Leia cala quando o consultor assume

Aconteceu com a Gisleide: consultora escreveu do celular às 12h19, cliente
respondeu às 12h39, e a Leia entrou no mesmo minuto se apresentando do zero.
`aoConsultorAssumir` movia só a etapa do funil.

Agora escrever do aparelho põe a conversa em modo humano na hora. Cobre o
caso que o handoff não cobria: conversa que o consultor **inicia**.

**Efeito colateral a vigiar:** toda conversa que um consultor tocar pelo
celular fica em modo humano **até ser reativada no painel**. Se a equipe usa
o celular para responder coisas rápidas esperando que a Leia retome sozinha,
isso mudou.

Junto veio o fechamento de uma corrida: a Evolution devolve como `fromMe`
tudo que sai da instância, e as duas checagens de eco só enxergavam o que já
estava gravado — o `queue-processor` grava DEPOIS de enviar. A terceira
checagem consulta a FILA. Sem ela, a mensagem da campanha calaria a Leia
justamente para quem acabou de recebê-la.

### Prompt aparado com dado, não palpite

Medido em 89 conversas reais e 631 mensagens: app FITI 0,5%, cancelamento
0,5%, afastamento 0,2%, objeto esquecido 0,2%, troca de horário **0,0%**.
Esses cinco eram a seção "Como conduzir o atendimento de aluno matriculado" —
3.794 tokens, 17% do prompt.

A BASE desses assuntos já carregava sob demanda (16%); a CONDUÇÃO ia em 100%.
Virou `knowledge/conducao-matriculado.md`, no módulo `matriculado`.

Prefixo no caminho comum: **48.875 para 45.333 tokens, -7%**.

**A detecção do infantil foi medida e NÃO deve ser mexida.** A regra de idade
parecia solta, mas em 81 conversas ela só decidiu uma — e acertou ("natação
para 4 anos", sem palavra-chave). Zero falsos positivos. A comparação
anterior (25% das chamadas contra 6,3% das mensagens) era de unidades
diferentes: conversa contra conversa dá 20%, e as 16 são genuínas.

### A Leia ouve áudio

O Claude **não aceita áudio** — a transcrição acontece fora dele em qualquer
cenário. Local foi medido e descartado: nesta VPS (2 vCPU, ~1,9 GB livres) o
modelo que caberia leva 20 a 40s por áudio. Groq faz em 300 a 750 ms por
~US$ 0,04 a hora.

**A Groq valida pela EXTENSÃO do nome.** O WhatsApp entrega `.oga`, que não
está na lista aceita (`ogg` e `opus` estão). Conteúdo idêntico, só o nome
reprova. Não está na documentação.

A transcrição roda **antes** do opt-out e da porta de consentimento. Na
primeira versão estava depois, e um "SAIR" falado passaria batido.

Os 8 áudios antigos foram transcritos e gravados. Dois eram intenção de
compra perdida: **Ma Prof Barbara** pedindo aula experimental e **Tassia
Santos** dizendo que ia fechar o anual. As duas em `human`, esperando
consultor.

### Fim de noite: dois defeitos que a campanha revelou

A campanha rodando com gente real achou o que teste nenhum tinha achado.

**Números às 22h:** 11 enviadas, **9 responderam (82%)**, 0 supressões
legítimas, 26 alvos pendentes.

#### 1. A preposição "para" virava pedido de descadastro (`cb86080`)

`/^parar?/` casava com **"Para mim"**, "Para minha filha", "para
academia". O `r` opcional mais a fronteira de palavra transformavam a
palavra mais comum do português em opt-out.

E o pior é de onde a frase vem: "Para mim" é a resposta à pergunta que **a
própria Leia faz** na qualificação — *"é para você ou está pesquisando para
outra pessoa?"*. O roteiro de vendas provocava a supressão do lead que
estava respondendo direito.

Aconteceu com **Paula Ferreira** e **Taís Lira**. A Paula conversou uma hora,
respondeu "Para mim" e recebeu *"Prontinho, não te mando mais mensagem por
aqui"*. Ela respondeu *"Não entendi"*. As duas supressões foram removidas.

A mesma família de erro estava na porta de consentimento: `/^n[aã]o/`
casava com **"Não entendi"**, "Não sei", "Não tenho certeza" — pedidos de
ajuda de quem ficou confuso. Encerrar a campanha neles perde exatamente
quem estava interessado.

> ⚠️ **A lição, e vale para todo código novo:** âncora curta demais numa
> língua em que a palavra continua. `para` → `para mim`; `não` → `não
> entendi`. Desconfie de qualquer `/^palavra/` em português.

Agora "parar" e "pare" exigem a forma verbal completa, "para" só vale
sozinho, e "não" precisa estar sozinho ou seguido de palavra de recusa.
Conferido em 39 casos.

#### 2. O agente não sabia o que a campanha prometeu (`05b735f`)

A Paula perguntou "Gostaria de saber como funciona" — 44 caracteres, acima
do limite de 40, então a porta de consentimento devolveu `outro` e passou
ao agente completo. Correto por desenho.

Mas o agente **não recebia a oferta**. Ela vive em `crm_campanhas.oferta`, e
ele só tem o prompt de vendas e a base. Leu a própria mensagem de campanha
no histórico — *"montamos uma condição pensada para quem já foi aluno"* — e
não fazia ideia de qual era. Improvisou com a tabela comum: ofereceu
**Performa 12x R$ 199** onde a campanha prometia **AQUA anual 10x R$ 264**.

Pelo mesmo motivo se reapresentou ("Sou a Leia, consultora virtual") numa
conversa que ele mesmo abriu meia hora antes.

`campanhaDoContato()` agora devolve a oferta e o link de checkout daquela
pessoa, e isso entra na **camada 3** do system — depois do breakpoint de
cache, porque é por conversa e no bloco estável invalidaria o prefixo de
todo mundo. Só vale enquanto a campanha está viva para ela.

#### A correção do consultor está funcionando

Reportaram a Elisangela Castello como recaída. Não era: as três intromissões
da Leia são de **24/08**, antes do conserto de 25/08 19:32. Depois dele,
**zero** mensagens do bot naquela conversa — inclusive quando ela mandou
áudio às 23:47, que foi transcrito em tempo real para a consultora ler sem
a Leia se meter.

Ao investigar caso reportado, conferir o **horário do deploy** antes de
concluir que a correção falhou.

### Pendências

- **Sem tela de campanha e sem tela de custo.** Só CLI e SQL:
  `npm run campanha -- status <slug>` e `select * from wa_ai_usage_diario`.
- **Alvo de campanha não entra no funil** até responder — campanha grava em
  `crm_campanha_alvos`, o funil lê `crm_leads`.
- **27 alvos ainda pendentes** na `aqua-anual-2026`, teto 20/dia.
- **Custo: ~$0,50 por conversa, ~$8/dia** (~$240/mês no volume atual). 486
  mil tokens de escrita de cache num dia — o prefixo é reescrito ~10x, uma
  por hora. Pré-aquecer não resolve; só prefixo menor resolve.
- **`unknown` são 28 mensagens (3,2%)**, mais que áudio. Tipos não tratados
  que recebem "[mensagem não suportada]". Nunca foram levantados.
- **Segunda instância na Evolution não foi feita.** Hoje um bloqueio derruba
  atendimento, follow-up e campanha juntos. O desenho está discutido: a
  mudança de fundo é que NADA no modelo de dados sabe por qual número nosso a
  conversa passou (`evolution.js` tem a instância fixa no módulo,
  `webhook.js` nunca lê `event.instance`).
- **`CreateMembership` continua assinado e tratado como venda**, mas pela doc
  do EVO é o CATÁLOGO de planos, não contrato de aluno. Inerte hoje.
- **Eventos de churn não assinados:** `ScheduleCancelMembership` (cancelamento
  AGENDADO, sabe antes da pessoa sair), `CancelMembership`, `Freeze`,
  `ClearedDebt`. O primeiro é o mais valioso do sistema para retenção.

## O que foi feito em 24/08/2026 — custo de crédito

A pergunta era "como reduzir custo de créditos". A resposta começou por medir,
com `count_tokens` contra o `claude-opus-5`, o que de fato vai no prompt:

| Camada | Tokens |
|---|---:|
| Prompt do banco (`vendas`) | 21.741 |
| Base de conhecimento (9 arquivos) | 38.038 |
| Declaração das tools | 1.915 |
| **Prefixo reenviado em TODA chamada** | **61.694** |

Com isso, ~95% do custo de entrada estava num bloco idêntico em toda conversa de
todo cliente — e cada volta do loop de tools paga esse bloco de novo.

### O que mudou

1. **TTL do cache de 5 min → 1h** (`CACHE_TTL` em `ai-agent.js`). Era o item
   mais grave: escrever o cache custa 1,25x o preço de entrada e ler custa 0,1x,
   contra 1x de não ter cache nenhum. Com 5 minutos e ritmo de WhatsApp, boa
   parte das conversas só escrevia e nunca lia — ou seja, o cache estava
   **encarecendo** o sistema. Verificado depois da mudança: 1ª chamada $0,4923
   (escrita), 2ª chamada **$0,0305** (leitura). 16x.

2. **Agrupamento de mensagens picotadas** (`webhook.js`). Cada balão do
   WhatsApp disparava um turno completo. Agora o cronômetro reinicia a cada
   mensagem e só o silêncio dispara a resposta (`AGENTE_DEBOUNCE_SEGUNDOS=12`,
   teto de 45s). Também impede dois turnos correrem juntos na mesma conversa.
   Corta o custo do caminho mais movimentado na proporção do quanto o cliente
   picota — **e melhora a resposta**, que antes saía antes de a pergunta
   terminar.

3. **Base de conhecimento em módulos** (`services/knowledge.js`). O núcleo vai
   sempre; `infantil` e `matriculado` entram por sinal da conversa. A
   detecção erra para o lado de carregar demais de propósito, e quando erra para
   menos o próprio agente pede o módulo pela tool `carregar_base` — que **não**
   devolve o texto no `tool_result` (ali ficaria fora do cache, a preço cheio),
   e sim remonta o `system`.

4. **Follow-up com caminho próprio** (`gerarFollowup` + `prompts/followup.md`).
   Escrever "como foi a aula?" carregava os 61.694 tokens do atendimento
   completo. Agora são **844** — sem base e sem tools. O preço: sem a base
   carregada, o prompt proíbe afirmar qualquer dado da academia. Roteiro novo
   que precise de um fato tem que voltar para `processMessage`.

5. **Telemetria por chamada** (`services/ai-usage.js` + migration 004). Uma
   linha em `wa_ai_usage` por chamada à API, não por turno — o `logger.debug`
   anterior rodava uma vez só, no fim do turno, e em nível que não aparece em
   produção. A view `wa_ai_usage_diario` dá custo por dia, por origem e por
   conversa, mais a `taxa_cache`.

### Prefixo depois da mudança

| Combinação | Prefixo | vs. 61.694 |
|---|---:|---:|
| `nucleo+adulto` (venda adulto, o caso comum) | 48.875 | **-21%** |
| `nucleo+adulto+matriculado` | 53.049 | -14% |
| `nucleo+adulto+infantil` | 58.551 | -5% |
| Todos os módulos (pior caso) | 62.638 | +2% |
| Follow-up | 844 | -99% |

O pior caso ficou 2% acima do que era: o índice de módulos no cabeçalho da base
e a tool `carregar_base` custam ~950 tokens. É o preço de a conversa comum
pagar 21% a menos.

### ⚠️ Pendências desta mudança

- **Migration 004 NÃO foi aplicada.** Rode `supabase/migrations/004_ai_usage.sql`
  no SQL Editor. Enquanto não rodar, a telemetria loga um `warn` por chamada e
  não grava nada — o atendimento segue normal.
- **`npm run prompt` não é necessário** — nada em `vendas.md` mudou. Mas o
  prompt ainda **não menciona** `carregar_base`; hoje o agente descobre a tool
  só pela descrição dela e pelo cabeçalho da base. Se aparecer transferência
  para humano em assunto de módulo ausente, é aqui que se corrige.
- **Buffers de agrupamento vivem em memória.** Restart com mensagem pendente
  perde a resposta daquele turno (a mensagem do cliente já está gravada). Vale
  enquanto for um processo só.
- **Modelo não foi trocado.** Segue `claude-opus-5`. Sonnet 5 sai ~40% mais
  barato e é decisão em aberto — a telemetria da 004 é o que dá base para
  decidir com número em vez de palpite.

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

Tudo está **no ar e funcionando**: migrations 001–007 aplicadas, prompt
publicado, WhatsApp conectado, quatro workers rodando. Não há passo de
instalação pendente.

O que vale fazer a seguir, em ordem de retorno:

**1. Ler o que a régua de silêncio escreveu.** É a prioridade do dia seguinte.
Ela rodou pela primeira vez em 28/08 e mandou ~45 retomadas para gente real, e
**ninguém leu ainda**. O roteiro proíbe comentar o sumiço e manda retomar o
assunto onde parou — se isso não estiver acontecendo, é ajuste de roteiro em
`instrucao()`, no `followup-worker.js`. No painel: **Conversas**, ou

```sql
SELECT tipo, mensagem, sent_at FROM crm_followups
WHERE tipo LIKE 'silencio%' AND status = 'enviado' ORDER BY sent_at DESC;
```

**2. Acompanhar a campanha nova.** 24 alvos pendentes em
`aqua-inativos-dez24-jun25` saem no dia seguinte. Comparar a taxa de resposta com
os 37,8% do piloto: a coorte é outra (dez24–jun25), e é justamente para poder
comparar que ela ficou em campanha separada.

**3. Esvaziar a fila de conversas paradas.** Conversas em `human` estão com a
Leia pausada, cada uma esperando um consultor. No painel: **Conversas → filtro
"Com consultor"**, e *Devolver para a Leia* nas resolvidas. Com a régua de
silêncio ligada isto pesa mais do que antes: conversa em `human` **cancela** a
cutucada, então lead esquecido nessa fila não recebe nem follow-up nem gente.

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
   ninguém preenche (0 de 11 contatos).

   ⚠️ **Resolvido só para o follow-up, em 28/08/2026.** `situacaoComercial()`
   pergunta ao EVO em vez de adivinhar, e a régua de silêncio não fala mais com
   aluno de contrato ativo. **O agente continua sem o sinal**: a abertura segue
   escrita para não presumir. Preencher `evo_member_id` na criação do contato
   continua sendo o que resolve de verdade — e agora há uma função pronta para
   isso.
2. ~~**Follow-up agendado**~~ (bloco 7 da revisão) — **resolvido em 28/08/2026.**
   Quem some depois de ver preço não some mais em silêncio: `silencio_1` sai em
   2 dias, `silencio_2` em 4, e depois o lead é encerrado como perdido. Ver a
   seção de follow-up.
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
