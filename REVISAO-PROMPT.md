# Revisão do prompt e da base — achados de 19/08/2026

> Auditoria do `vendas.md`, dos 8 knowledge files e do caminho de código que
> monta o system prompt, feita depois da primeira rodada de testes pela página
> `/teste`. É uma **lista de correções pendentes**, não um relatório: cada item
> diz onde está, por que importa e o que fazer.
>
> ✅ **Parcialmente aplicado em 20/08/2026** — ver "O que já foi aplicado",
> logo abaixo. O resto segue pendente. Ver [HANDOFF.md](HANDOFF.md) para o
> estado do projeto e [INFORMACOES-PENDENTES.md](INFORMACOES-PENDENTES.md) para
> as lacunas de conteúdo da base.
>
> ⚠️ As referências de linha valem para o estado do repositório em 19/08/2026
> (commit `38f41df`). Elas andam a cada edição — confira o trecho, não o número.

## Contexto: o que esta auditoria não viu

A revisão foi feita numa máquina **sem `.env`, sem `node_modules` e sem a chave
`~/.ssh/aquap_vps`** — então não foi possível exportar as conversas nem entrar na
VPS. É auditoria estática do texto e do código, cruzada com os números da rodada
já registrados em `INFORMACOES-PENDENTES.md` (3 conversas, 34 mensagens, 3 em 3
terminando em handoff).

**Primeira coisa a fazer na máquina de casa** — ler o que os testes realmente
produziram, para conferir o que a leitura estática não pega (tom, tamanho de
mensagem, se o agente obedeceu o formato WhatsApp):

```bash
node scripts/exportar-conversas.js --canal=web-test
# gera data/conversas/transcricoes.md e conversas.json (fora do git)
```

## Ordem sugerida de aplicação

| # | Bloco | Onde | Vale no atendimento depois de |
|---|---|---|---|
| 1 | Data/hora e bloco de contato | `src/services/ai-agent.js` | deploy na VPS |
| 2 | Contradições da base e do gerador da grade | `knowledge/*.md`, `scripts/gerar-grade-horaria.js` | deploy na VPS |
| 3 | Follow-up agendado por `scheduled_for` (bloco 7) | `src/services/ai-agent.js` + fila | deploy na VPS |
| 4 | Campo `dados_coletados` no handoff | `src/services/ai-tools.js` | deploy na VPS |
| 5 | Roteiro da frente 2 (aluno matriculado) e o fechamento 12:30–15:00 | `src/prompts/vendas.md` | `npm run prompt` |

Lembrete das duas armadilhas já conhecidas: **prompt só entra no banco pelo
`npm run prompt`**, e **knowledge file só chega na VPS por deploy** — editar o
arquivo local não muda nada no atendimento.

## ✅ O que já foi aplicado — 20/08/2026

Decidido e escrito com o Leandro. **Nada disso vale no atendimento ainda:**
`vendas.md` exige `npm run prompt`, knowledge file exige deploy.

| O quê | Onde | Falta |
|---|---|---|
| Vigência da tabela removida (ver "Respondido pelo Leandro", no fim) | `knowledge/planos-e-valores.md` | deploy |
| Ancoragem em turnos, no lugar dos "10 segundos" (bloco 5) | `vendas.md` §6 | `npm run prompt` |
| Régua da Objeção 4 — desconto e "está caro" | `vendas.md`, matriz de objeções | `npm run prompt` |
| Handoff Financeiro reescopado para aluno matriculado (bloco 1b) | `vendas.md`, "Quando transferir" | `npm run prompt` |
| Aula experimental: responde, ajuda a escolher o horário, e só então transfere (bloco 1a) | `vendas.md`, fim da matriz de objeções | `npm run prompt` |
| FITI separando pergunta de venda de problema de conta (bloco 1c) | `vendas.md`, "Quando transferir" | `npm run prompt` |
| Contrapeso na regra de "dado fora da base" (bloco 1d) | `vendas.md` + `ai-tools.js` | `npm run prompt` + deploy |
| Clube Sábado na ordem de oferta (bloco 4) | `vendas.md` §6 | `npm run prompt` |
| Agregadores sem nome fixo — só o ponteiro para a base (bloco 4) | `vendas.md`, frentes de trabalho | `npm run prompt` |
| "Três frentes" e o cafezinho virando placeholder (bloco 5) | `vendas.md` | `npm run prompt` |

### A ancoragem nova, em uma linha

Mensal (com a adesão) **citado e descartado na mesma frase** → Assinatura
descrita como formato mais comum → fecho com pergunta de reação e a promessa de
**montar um plano** para ela → turno seguinte, o Anual, único plano que a Leia
diz indicar. Regra de turno, não de tempo: o modelo roda uma vez por mensagem
recebida e não tem relógio.

Três decisões que sustentam isso, para não serem desfeitas por engano:

- **A âncora é o Mensal, não a Assinatura** — R$ 279 + R$ 184 de adesão contra
  R$ 239 é uma âncora bem mais alta que R$ 239 contra R$ 199. Descartá-la na
  mesma frase evita o susto: a batida deixa de ser "é caro demais" e vira "ela
  está do meu lado". E não custa um turno a mais.
- **O gancho promete composição, nunca preço menor.** Dizer que existe algo mais
  barato avisa que o valor recém-dado não era real, e a pessoa para de avaliar a
  proposta para esperar a oferta "de verdade".
- **"É o que eu indico" aparece uma única vez, e é no Anual.** Recomendar a
  Assinatura e trocar a recomendação depois é exatamente o que faz a conversa
  parecer enrolação.

⚠️ **Por que a Objeção 4 tinha que ir junto:** a ancoragem nova põe a adesão de
R$ 184 na mesa mais cedo, de propósito — é ela que faz a isenção do Anual valer
alguma coisa. Sem o reescopo do Financeiro, isso aumentaria o handoff em vez de
reduzir.

---

---

## 1. 🔴 Por que todo lead bem conduzido termina em handoff — ✅ blocos a, b, c e d aplicados em 20/08/2026

Os três motivos registrados na rodada de 19/08 não são acaso: são quatro regras
do prompt disparando cedo demais. É o bloco de maior impacto na conversão.

### a) A regra da aula experimental está desatualizada — ✅ aplicado em 20/08/2026

`vendas.md` (fim da matriz de objeções, ~linha 391) ainda diz que as condições da
aula experimental "estão PENDENTE" e manda transferir se a pessoa perguntar como
funciona. **Deixou de ser verdade:** `informacoes-gerais.md` já responde que
existe, é gratuita, o que levar, e que o consultor só faz o agendamento em si.

O agente está transferindo com "não sei" exatamente no ponto em que o roteiro
manda fechar.

**Correção:** confirmar que existe e é gratuita, **ajudar a escolher o horário na
grade**, e só então transferir — com atividade e horário já combinados no
`motivo`. É o mesmo handoff, com valor completamente diferente para o consultor.

### b) "Financeiro … negociação" captura objeção de preço de lead novo — ✅ aplicado em 20/08/2026

`vendas.md`, seção "Quando transferir para humano": *"Financeiro — pagamento
pendente, cobrança, estorno, negociação"*, sob a instrução "imediatamente, sem
tentar resolver".

"Negociação da taxa de adesão de R$ 184" caiu aí — mas essa é a objeção que o
próprio prompt sabe responder: **o Anual é isento da adesão.** O agente
transferiu em vez de usar o melhor argumento que tem.

**Correção:** escopar "Financeiro" a **aluno já matriculado** (pagamento
pendente, cobrança, estorno, troca de forma de pagamento) e abrir a exceção
explícita: *pedido de desconto ou reclamação de preço em venda nova → primeiro o
Anual isento de adesão e a combinação de formas de pagamento; só transfira se a
pessoa insistir em condição fora de tabela.*

### c) A regra do FITI se contradiz — ✅ aplicado em 20/08/2026

O cabeçalho da seção diz "transferir **imediatamente, sem tentar resolver**"; o
item do FITI diz "apresente o processo padrão de agendamento e na sequência
transfira". Nas duas leituras o handoff acontece.

**Correção:** falta a distinção que importa — *"como funciona o agendamento?"* é
pergunta de venda (responde e segue); *"não consigo entrar no app / minha reserva
sumiu"* é conta (transfere).

### d) A regra guarda-chuva tem três reforços e nenhum contrapeso — ✅ aplicado em 20/08/2026

"Qualquer dado que não esteja na base de conhecimento" (`vendas.md`) +
`NO_KNOWLEDGE_GUARD` (`ai-agent.js`) + a descrição da tool
`transferir_para_humano` (`ai-tools.js`) empurram todos para a mesma saída fácil.

**Correção:** acrescentar o contrapeso que hoje não existe em lugar nenhum —
*antes de transferir por falta de dado, verifique se a pergunta pode ser
respondida com o que existe; transfira só o que falta, sem encerrar a conversa.*

⚠️ **Correção da auditoria:** `NO_KNOWLEDGE_GUARD` não é um terceiro reforço no
uso normal. Lendo `ai-agent.js`, ele só entra quando a base **falha ao carregar**
(pasta vazia ou erro de leitura) — nesse cenário mandar transferir é o
comportamento certo e ficou como está. Os reforços reais eram dois: o `vendas.md`
e a descrição da tool. Os dois foram corrigidos.

---

## 2. 🔴 O agente não sabe que dia é hoje

Em `ai-agent.js` (`processMessage`, camada 3) o único bloco dinâmico é o do
contato — nome, telefone, prospect, tags. **Nenhuma data ou hora entra no system
em momento algum.** Com a grade horária inteira carregada no contexto, isso
significa que o agente:

- não responde "tem natação hoje à noite?" nem "amanhã de manhã";
- não sabe se está dentro do horário de atendimento, mas o prompt manda avisar
  quando está fora;
- sugere "vir fazer uma aula experimental **hoje**" (exemplo da objeção 3) sem
  saber se hoje é domingo.

**Correção:** um bloco com data, dia da semana e hora em `America/Sao_Paulo`
**no segundo elemento do array `system`**, junto do contexto do contato — depois
do `cache_control`. Antes do breakpoint ele invalidaria o cache a cada minuto.

### Bug de contexto no mesmo trecho

`contactInfo.name ? ... : ''` faz o bloco inteiro desaparecer quando não há nome.
Na página `/teste` o contato nasce com `name: null` (`routes/teste.js`), então
**boa parte das conversas de teste rodou sem nenhum contexto de contato** —
inclusive sem o `is_prospect`, que distingue lead de aluno.

**Correção:** montar o bloco sempre, com o nome como campo opcional dentro dele.

---

## 3. 🟡 Contradições dentro da própria base

Onde a base se contradiz, o agente escolhe uma versão por sorteio — e não avisa.

| Contradição | Onde | O que vale |
|---|---|---|
| **2 vs 3 agendamentos simultâneos** | `operacional-adulto.md` e `contrato-resumo.md` dizem 3; `grade-horaria.md` (seção Musculação) diz 2 | 3 — já decidido em 18/08 |
| **Duração da aula adulta** | `atividades.md` diz 45 min; `grade-horaria.md` diz que "não consta", sob o título "não invente estes dados" | 45 min. Como está, o agente transfere numa pergunta já respondida |
| **Piscina aquecida** | `informacoes-gerais.md` dá a temperatura (30–30,5 °C) e a FAQ confirma, mas a nota da seção Estrutura avisa que a afirmação "nunca foi confirmada" | O dado. A nota ficou obsoleta quando o campo foi preenchido, e hoje só serve para o agente hesitar num diferencial forte |
| **Idade da natação bebê** | "até entre 3,5 e 4 anos" em três arquivos; "a 3 anos e 6 meses" no cabeçalho da seção Natação Bebê da grade | "entre 3,5 e 4 anos" — decisão do item 6 do pente fino |

⚠️ **As duas primeiras vivem no gerador, não no `.md`:**
`scripts/gerar-grade-horaria.js` (as linhas que escrevem "até 2 sessões" e o
bloco "Pendências desta grade"). Corrigir só o markdown seria desfeito no
próximo `npm run grade`.

### Um mapeamento que falta

`planos-e-valores.md` define frequência semanal por **Iniciante / Intermediário /
Aperfeiçoamento** (2 / 3 / 5 sessões). A base infantil fala em **Golfinho I**,
**N3 Amarela**, **N5 Laranja**. Nenhum arquivo liga os dois vocabulários.

"Meu filho está no N3, quantas vezes por semana ele nada?" exige três saltos de
inferência. Uma tabela de duas colunas resolve.

Relacionado: a grade apresenta a sexta como *a* aula extra, mas o Aperfeiçoamento
precisa de 3 extras. Vale explicitar que os tíquetes são agendados livremente no
FITI (como diz o `contrato-resumo.md`), não só na sexta.

---

## 4. 🟡 Buracos no roteiro de venda

- ✅ **Clube Sábado — aplicado em 20/08/2026.** Não aparecia uma única vez no `vendas.md`. A base diz "antes de
  descartar um lead por indisponibilidade na semana, ofereça o Clube Sábado", mas
  a "Ordem de oferta" do prompt só conhece Performa / Aqua / Plus. Quem só pode
  sábado hoje ouve "não temos horário".
- **O fechamento das 12:30 às 15:00** é tratado pela base como informação de
  venda, e a etapa 4 do prompt (Disponibilidade) não pergunta nada a respeito.
  Descobrir isso depois da matrícula é churn.
- ✅ **Wellhub/Gympass — aplicado em 20/08/2026.** Apareciam no prompt (frente 2, "convênio ou agregador") na
  frase que diz que agregador é atendido normalmente — mas a base é clara: só
  Totalpass, a partir do TP4. Basta tirar os nomes e deixar o ponteiro.
- **A frente 2 (aluno matriculado) não tem roteiro.** O prompt é ~95% venda. Como
  o WhatsApp de atendimento é o mesmo número principal da academia
  (11 94071-5006), quando o canal real entrar no ar **a maioria do volume será
  aluno, não lead** — e para esse público o prompt só oferece regras de
  transferência. É a maior lacuna de escopo para a virada de chave.

---

## 5. 🟡 Instruções que o modelo não consegue cumprir

### "Aguarde aproximadamente 10 segundos" — ✅ aplicado em 20/08/2026

Na seção 6 (Apresentação dos planos e valores). O agente não tem relógio nem
indicador de digitação: responde uma vez por mensagem recebida. Na prática ou
ignora, ou verbaliza a espera, ou despeja Assinatura e Anual juntos — matando a
ancoragem que a regra queria proteger.

A intenção é boa e é uma regra de **turno**, não de segundos:

> Apresente a Assinatura e pare. O Anual só no turno seguinte, depois da reação
> dela. Se ela não reagir ao valor, aí sim puxe o Anual.

(Aproveite e corrija o "aroximadamente".)

### "menos que um cafezinho" — ✅ aplicado em 20/08/2026

Está colado num exemplo que pode sair com R$ 9,90/dia (Estilo de Vida Plus). Em
São Paulo isso não sustenta a comparação e queima credibilidade no ponto mais
sensível da conversa. A instrução logo acima já é a certa — "associe a um item de
consumo diário de valor equivalente"; o exemplo é que precisa virar placeholder.

### Outros

- ✅ **"Seu trabalho tem duas frentes:" seguido de três itens** — corrigido para "três frentes" em 20/08/2026.
- **Formato de saída.** O prompt proíbe `**`, `##` e tabelas — e vem acompanhado
  de ~96 mil caracteres escritos exatamente nesse formato. É muita pressão de
  imitação contra uma regra declarativa. Contrapeso barato: um bloco curto com
  dois ou três **exemplos de resposta já no formato WhatsApp**, mostrando o
  resultado em vez de descrevê-lo.
- **Notas para humanos que o modelo lê como conteúdo:** o `<!-- CONFERIR -->` da
  `anamnese-perfil-cliente.md` diz ao agente que aquelas regras "não são
  protocolo oficial"; "Última geração: 18/08/2026", "Edite este arquivo sempre
  que…" e a nota da piscina caem na mesma categoria. Ou saem na geração, ou viram
  comentário que o loader remove.

---

## 6. ⚪ Dois ajustes fora do texto que mudam o resultado

**A tool de handoff devolve pouco.** `transferir_para_humano` só tem `motivo` e
`mensagem`. Como 100% das conversas bem conduzidas terminam ali, um campo
`dados_coletados` (nome, modalidade, horário preferido, plano em discussão, para
quem é) transforma a fila de "alguém pediu ajuda" em lead pronto — e ataca metade
do problema de "handoff não notifica ninguém" sem depender da notificação.

**Peso do contexto.** A base infantil sozinha são 23,4 mil caracteres, ~29% da
base, relevante só quando o lead é pai ou mãe. **Não mexer nisso agora:** com o
cache funcionando o custo é marginal, e carregamento condicional cria dois
prefixos de cache. O ganho real aqui é remover contradição, não volume —
resolvidos os itens 3 e 5, se a diluição ainda incomodar, aí vale medir.

---

## 7. 🔴 Follow-up: a infraestrutura existe e ninguém usa

*Achado de 20/08/2026, fora da auditoria original.*

O agente **só roda quando chega mensagem** — um `messages.create` por mensagem
recebida, sem debounce e sem agendador ([ai-agent.js:264](src/services/ai-agent.js#L264)).
Consequência: **quem some, some em silêncio.** Nenhuma regra de prompt recupera
essa conversa, porque não existe turno em que o modelo possa agir.

Isso é grave logo depois do turno da âncora, que é onde a pessoa vê preço pela
primeira vez. Foi por isso que o fecho do turno virou pergunta + promessa de
montar um plano: reduz o risco. **Mas reduzir não é recuperar.**

O que recupera é follow-up agendado — e **está tudo pronto, só não é chamado:**

- [001_whatsapp_schema.sql:112](supabase/migrations/001_whatsapp_schema.sql#L112) —
  `wa_message_queue.scheduled_for TIMESTAMPTZ`, com índice em `(status, scheduled_for)`
- [queue-processor.js:32](src/workers/queue-processor.js#L32) — o worker já filtra
  `scheduled_for <= now()`: mensagem com data futura fica parada e sai na hora
- [api.js:120](src/routes/api.js#L120) — a rota já aceita `scheduled_for` no corpo

Nada no fluxo do agente enfileira mensagem com data futura. **Correção:** quando
um turno de preço terminar sem resposta, enfileirar uma retomada para ~24h
depois, cancelada se a pessoa responder antes. Não exige construir nada.

Vale também para o outro buraco conhecido: enquanto o handoff não notifica
ninguém, o mesmo mecanismo dá o aviso de "ninguém respondeu esta fila".

---

## O que foi conferido e está certo

A aritmética inteira da tabela de preços adulto — as 12 células de economia
mensal, economia anual e valor por dia — bate com os preços dos três planos e com
a taxa de adesão de R$ 184. É o dado de maior risco da base e está consistente.

## Respondido pelo Leandro — 20/08/2026

**Vigência da tabela adulto: não é questão.** A tabela vale, e já estará em
vigor quando o agente atender conversas reais. Mais que isso, virou regra
permanente: **o agente não deve saber de vigência de tabela.** A tabela que está
na base é, por definição, a que vale — datas de vigência só criam hesitação e
ressalva numa resposta que deveria ser direta.

Aplicado: a linha `> Vigência: ...` saiu do cabeçalho do `planos-e-valores.md`.
Ao editar preços no futuro, troque os números e não registre período de validade
no arquivo.
