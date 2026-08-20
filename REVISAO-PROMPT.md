# Revisão do prompt e da base — achados de 19/08/2026

> Auditoria do `vendas.md`, dos knowledge files (8 na época, 9 hoje) e do caminho de código que
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

## Contexto: o que esta auditoria não viu — ✅ resolvido em 20/08/2026

A revisão de 19/08 foi feita numa máquina **sem `.env`, sem `node_modules` e sem
a chave `~/.ssh/aquap_vps`** — então não foi possível exportar as conversas nem
entrar na VPS. Foi auditoria estática do texto e do código.

**As transcrições foram lidas em 20/08/2026** e estão no bloco 8, no fim deste
documento — inclusive o que a leitura estática não pega: tom, tamanho de
mensagem, formato WhatsApp e o que o agente de fato fez. Para regenerar:

```bash
npm run conversas -- --canal=web-test
# gera data/conversas/transcricoes.md e conversas.json (fora do git)
```

## Ordem sugerida de aplicação

| # | Bloco | Onde | Vale no atendimento depois de |
|---|---|---|---|
| 1 | Follow-up agendado por `scheduled_for` (bloco 7) | `src/services/ai-agent.js` + fila | deploy na VPS |
| 2 | Campo `dados_coletados` no handoff (bloco 6) | `src/services/ai-tools.js` | deploy na VPS |
| 3 | Resto do roteiro da frente 2 e o fechamento 12:30–15:00 (bloco 4) | `src/prompts/vendas.md` | `npm run prompt` |

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
| Roteiro da frente 2: objeto esquecido e app FITI | `vendas.md` + novo `knowledge/suporte-fiti.md` | `npm run prompt` + deploy |
| Limite de agendamento completado: 3 no total, 1 por modalidade | `knowledge/operacional-adulto.md` | deploy |
| Achados e perdidos, e a linha "Feriados" da tabela de horário, que tinha uma célula faltando | `knowledge/informacoes-gerais.md` | deploy |
| Afastamento médico: regra, foto do atestado na conversa e handoff no mesmo turno | `vendas.md` + `contrato-resumo.md` + `operacional-adulto.md` | `npm run prompt` + deploy |
| Contradição do contrato resolvida: afastamento médico vale para **todos** os planos; férias/trancamento só o Anual | `knowledge/contrato-resumo.md` | deploy |
| Política de descontos: 65+, família de 3+, e nenhuma negociação | novo bloco em `knowledge/planos-e-valores.md` | deploy |
| Objeção 4 reescrita: desconto deixou de ser motivo de transferência | `vendas.md`, matriz de objeções | `npm run prompt` |
| Roteiro da frente 2: troca de horário de turma e cancelamento de contrato | `vendas.md` + `knowledge/informacoes-gerais.md` | `npm run prompt` + deploy |
| Prazo do atestado: também aceito após o retorno, se não frequentou | `contrato-resumo.md`, `operacional-adulto.md`, `vendas.md` | ambos |
| Descontos não acumulam: quem se enquadra nos dois tem 10%, não 20% | `knowledge/planos-e-valores.md` | deploy |
| Nota obsoleta da piscina removida (bloco 3) | `knowledge/informacoes-gerais.md` | deploy |
| Mapeamento nível ↔ frequência (Iniciante/Intermediário/Aperfeiçoamento × Adaptação…Atleta) | `knowledge/planos-e-valores.md` + ponteiro na base infantil | deploy |
| Horário infantil sem níveis listados = todos os níveis do grupo | `scripts/gerar-grade-horaria.js` + `grade-horaria.md` | deploy |
| Duração das aulas: seção própria na grade, 45 min adultas e coletivas | `scripts/gerar-grade-horaria.js` + `grade-horaria.md` | deploy |
| Idade da natação bebê: de 12 meses até entre 3,5 e 4 anos | `scripts/gerar-grade-horaria.js` + `grade-horaria.md` | deploy |
| Data, dia da semana e hora em `America/Sao_Paulo` no system (bloco 2) | `src/services/ai-agent.js` | deploy |
| Bloco de contato montado sempre, mesmo sem nome (bloco 2) | `src/services/ai-agent.js` | deploy |
| Cancelamento em três turnos, transferência no último (bloco 8) | `vendas.md` | `npm run prompt` |
| "Uma transferência por conversa" — fim das chamadas duplicadas (bloco 8) | `vendas.md` | `npm run prompt` |
| Valor por dia só existe na tabela adulto; nunca calcular (bloco 8) | `vendas.md` | `npm run prompt` |
| Proibido afirmar pico, lotação ou tranquilidade de horário (bloco 8) | `scripts/gerar-grade-horaria.js` + `grade-horaria.md` | deploy |
| Retenção no cancelamento: motivo trabalhado por professor e consultor, mais o argumento de reduzir em vez de parar | `vendas.md` | `npm run prompt` |

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

## 2. 🔴 O agente não sabe que dia é hoje — ✅ aplicado em 20/08/2026

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

### Bug de contexto no mesmo trecho — ✅ aplicado em 20/08/2026

`contactInfo.name ? ... : ''` faz o bloco inteiro desaparecer quando não há nome.
Na página `/teste` o contato nasce com `name: null` (`routes/teste.js`), então
**boa parte das conversas de teste rodou sem nenhum contexto de contato** —
inclusive sem o `is_prospect`, que distingue lead de aluno.

**Correção:** montar o bloco sempre, com o nome como campo opcional dentro dele.

---

## 3. 🟡 Contradições dentro da própria base — ✅ fechado em 20/08/2026

Onde a base se contradiz, o agente escolhe uma versão por sorteio — e não avisa.

| Contradição | Onde | O que vale |
|---|---|---|
| ✅ **2 vs 3 agendamentos simultâneos** — resolvido em 20/08/2026 | `grade-horaria.md` dizia 2; o gerador e o `.md` agora dizem o mesmo que a base | **3 no total, no máximo 1 por modalidade.** A regra completa veio das mensagens de erro do FITI; o "2" era simplesmente errado |
| ✅ **Duração da aula adulta** — resolvido em 20/08/2026 | a grade ganhou seção "Duração das aulas" própria, fora das pendências | **45 min** para adultas e coletivas; bebê 30 min; 3–5 e 6–12 anos 45 min |
| ✅ **Piscina aquecida** — resolvido em 20/08/2026 | a nota obsoleta da seção Estrutura foi removida do `informacoes-gerais.md` | Vale o dado: 15 m, coberta, 30–30,5 °C. A nota só fazia o agente hesitar num diferencial forte |
| ✅ **Idade da natação bebê** — resolvido em 20/08/2026 | corrigido no gerador da grade | **de 12 meses até entre 3 anos e meio e 4 anos** |

✅ **As quatro foram corrigidas em 20/08/2026, e o bloco 3 está fechado** — o
"Um mapeamento que falta", logo abaixo, também. As que viviam em
`scripts/gerar-grade-horaria.js` foram corrigidas **no gerador e no `.md`
juntos**, com `npm run grade` rodado para confirmar que batem: corrigir só o
markdown seria desfeito na próxima geração.

### Um mapeamento que falta — ✅ aplicado em 20/08/2026

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
- 🔸 **A frente 2 (aluno matriculado) não tinha roteiro — começou em 20/08/2026** (objeto esquecido e app FITI; o resto continua pendente). O prompt era ~95% venda. Como
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

## 8. Leitura das transcrições — 20/08/2026

*O que a auditoria estática não pôde fazer. Base: `npm run conversas -- --canal=web-test`,
**21 conversas, 238 mensagens, 15 com handoff**, de 19/08 02:57 a 20/08 21:58.*

### O achado que muda como ler todo o resto

**31% das respostas da Leia no corpus nunca teriam sido enviadas em produção** —
37 de 119, em 15 das 21 conversas.

A página `/teste` **não desliga a IA** no handoff, de propósito, para o teste não
morrer no ponto que mais interessa avaliar. Mas no WhatsApp o
`transferir_para_humano` pausa o bot. Então **toda conversa do corpus continua
além do ponto onde a real teria parado**, e qualquer contagem de mensagens, tom
ou condução depois do primeiro handoff descreve um bot que não existe.

Efeito colateral que isso revelou: **30 chamadas de handoff em 15 conversas**,
com a id12 chamando **sete vezes**. O modelo vê no histórico que já transferiu e
transfere de novo, porque nada dizia o que fazer depois. ✅ Corrigido em
20/08/2026 pela regra "Uma transferência por conversa" no `vendas.md`.

**Ao ler transcrições daqui em diante:** corte a conversa no primeiro handoff. O
que vem depois é laboratório, não atendimento.

### A taxa de handoff ainda não dá para comparar

| | Conversas | Com handoff |
|---|---|---|
| Antes das mudanças de 20/08 | 18 | 14 (**78%**) |
| Depois | 3 | 1 |

As 3 conversas do "depois" incluem duas de verificação técnica. **A ancoragem
nova, a régua da Objeção 4 e a política de descontos não foram exercitadas uma
única vez.** O número de referência para a próxima rodada é **78%**.

### Formato: a preocupação do bloco 5 não se confirmou

Em 119 respostas, **zero** ocorrências de `**`, `##`, tabela ou bloco de código.
Mediana de 260 caracteres e 2 linhas por resposta; 2 respostas acima de 600
caracteres; nenhuma com mais de 2 emojis.

O bloco 5 sugeria acrescentar exemplos em formato WhatsApp como contrapeso à
pressão de imitação dos ~96 mil caracteres de base em markdown. **Não é
necessário** — a regra declarativa está segurando sozinha.

### Duas invenções — ✅ ambas corrigidas em 20/08/2026

| O que ela inventou | Onde | Correção |
|---|---|---|
| *"As 19h são mesmo o pico aqui"* | id25 | A grade não registra movimento nem ocupação. Regra nova no gerador proíbe afirmar pico, lotação ou tranquilidade de horário |
| *"No Anual dá cerca de R$ 7,50 por dia"*, sobre natação infantil | id12 | Calculado (227÷30). A tabela "valor por dia" é **só de adulto**. O `vendas.md` agora proíbe calcular valor por dia fora dela — e a criança nada 2x na semana, então "por dia" engana mesmo se o número fechasse |

### O defeito do roteiro de cancelamento — ✅ corrigido em 20/08/2026

A id25 rodou às 18:47, depois do deploy do roteiro. A Leia perguntou o motivo
como mandava o texto, ouviu *"não tem vaga para eu parar o carro"* e **transferiu
no turno seguinte**. Dois turnos depois o cliente digitou o motivo real — *"as
aulas estão muito chatas"* — e ela conduziu bem, oferecendo troca de modalidade.

**Em produção nada disso teria acontecido:** o bot estava pausado desde o
estacionamento, e o motivo real nunca apareceria.

O defeito era do texto, não do modelo: "sempre pergunte o motivo antes de
encaminhar" foi cumprido ao pé da letra — perguntou, recebeu *uma* resposta,
encaminhou. Faltava dizer que **o primeiro motivo dito quase nunca é o real** e
que a alternativa concreta vem **antes** do encaminhamento. O cancelamento virou
regra de três turnos, com a transferência no último.

Junto veio outro sintoma no mesmo diálogo: ela escreveu "já estou te passando
para um consultor" e, na mesma mensagem, seguiu perguntando. Ou encaminhou, ou
está conduzindo — agora está dito.

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
