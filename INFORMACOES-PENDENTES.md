# Informações pendentes — o que o bot ainda não sabe

> Levantado durante a construção e os testes de 15/08/2026.
> **Revisado no pente fino de 18/08/2026**, depois da importação da grade real.
> Cada item diz **onde vai**, **por que importa** e **o que acontece hoje sem ele**.
>
> Regra geral: enquanto o dado não estiver num arquivo de
> `src/prompts/knowledge/`, o agente transfere para humano em vez de responder.
> Isso é o comportamento seguro — mas cada transferência dessas é uma venda que
> não avançou sozinha.

---

## ✅ Resolvido no pente fino de 18/08/2026

| # | Era | Ficou |
|---|---|---|
| 1 | Nome contraditório | **AP Academia**, academia completa. O arquivo que dizia "de Natação e Hidroginástica" foi apagado. |
| 2 | `vendas.md` prometia estorno de 30 dias inexistente | **Garantia de Adaptação de 21 dias**, com as duas condições (8 atividades + questionário de satisfação), em `operacional-adulto.md` e no roteiro de objeção. |
| 3 | Turmas de sábado sem preço | **Clube Sábado** em `planos-e-valores.md`: 12x R$ 147 anual / R$ 179 assinatura / R$ 197 mensal, matrícula R$ 105 no mensal e assinatura. Vale para infantil **e** adulto 13+. |
| 4 | Horário de funcionamento inexistente | **06:00–12:30 e 15:00–22:00**, seg a sex, em `informacoes-gerais.md`. A grade também deixou de sugerir horário contínuo. |
| 5 | Zumba na tabela de planos | Trocado por **Ritmos**, com nota em `atividades.md` para quem perguntar por Zumba. |
| 6 | Idade do bebê em 3 versões | **De 1 ano até entre 3,5 e 4 anos**, e **não existe turma Bebê 3**. |
| 7 | Tamanho de turma × vagas do horário | Confirmado: no mesmo horário a piscina recebe mais de uma turma, divididas por nível. A grade fala em "vagas no horário" e manda usar os números da base ao falar de turma reduzida. |
| 8 | Regras operacionais espalhadas | Consolidadas em `operacional-adulto.md`; o `vendas.md` só aponta para lá. |
| 9 | Nenhuma descrição das atividades | `atividades.md` criado — o que é cada aula, para quem costuma fechar, e onde falta o diferencial. |
| 10 | Sábado e domingo sem horário | **Sábado 08:30–13:00; domingo não abre.** |
| 11 | Clube Sábado sem regra de acesso | **Adulto faz todas as atividades do plano no sábado; infantil só a aula matriculada.** |
| 12 | Garantia de 21 dias sem escopo | **Exclusiva do Plano Anual** — vira argumento a favor do Anual, não concorrente dele. |

---

## ✅ Resolvido com a síntese do contrato (18/08/2026)

O contrato de prestação de serviços foi condensado em
`src/prompts/knowledge/contrato-resumo.md`. O que ele fechou:

| # | Era | Ficou |
|---|---|---|
| 13 | Cancelamento de contrato sem regra | Regra por tipo de plano: **Assinatura** com 30 dias de aviso por e-mail e **sem multa**; **Anual** com acerto de saldo (descontos revertidos, sem devolução no último mês). Canal: `cancelamento@apacademia.com.br`. |
| 14 | Devolução dos 21 dias: integral? de quando conta? | **Total**, contada **da matrícula** — mantidas as 8 sessões + questionário. |
| 15 | Nada sobre atestado médico | **Decidido: quem informa é o consultor.** O agente responde que o consultor detalha isso na matrícula e **segue a conversa — sem transferir por causa disso**. |
| 16 | Férias do Anual sem detalhe | 30 dias em até **3 pedidos**, com **7 dias de antecedência**. Assinatura não tem férias nem trancamento. |
| 17 | Transferência de plano desconhecida | Permitida **uma vez**, para **uma única pessoa**, com novo contrato. |
| 18 | Reposição infantil contradizia `informacoes-gerais.md` | **Vale a base:** não há reposição, salvo força maior com atestado. Os **tíquetes extras** (+1 no Intermediário, +3 no Aperfeiçoamento) ficam — são sessões a mais na semana, não reposição, e explicam as 3 e 5 sessões da tabela de preços. |
| 19 | Vestuário, tolerância, uso de imagem, convivência | Todos no `contrato-resumo.md` (jeans/chinelo/salto proibidos, touca e maiô obrigatórios, 10 min de tolerância na piscina, imagem autorizada com recusa por e-mail, penalidades graduais). |

| 20 | Formas de pagamento PENDENTE | **Crédito, débito, PIX à vista, cheque e dinheiro**, em `operacional-adulto.md`, e **podem ser combinadas** (2 cartões, entrada no PIX + saldo parcelado). PIX é sempre à vista — não existe PIX recorrente; a Assinatura é débito no cartão de crédito. |

> **Fica de fora de propósito:** o agente não calcula saldo, multa nem valor de
> devolução de caso concreto — não tem os dados do contrato do aluno. Nessas
> perguntas ele explica a regra e transfere.

### Divergências que serão corrigidas no contrato, não na base

Decisão de 18/08/2026: **onde contrato e base divergem, a base está certa.** O
`contrato-resumo.md` já segue a base; o documento contratual é que será
atualizado.

| Ponto | O que o contrato diz hoje | O que vale |
|---|---|---|
| Reposição infantil | Iniciante tem 2 reposições/mês, usáveis em 15 dias | Não há reposição, salvo força maior com atestado |
| Falta não justificada | Nada | **2 dias sem poder agendar** pelo app — **a academia vai incluir no contrato** |
| Agendamentos simultâneos | 2 | **3** |
| Formas de pagamento | Só cita o débito recorrente da Assinatura | Crédito, débito, PIX à vista, cheque e dinheiro — **a academia vai incluir no contrato** |
| Renovação do atestado | "a cada 6 meses nos cursos terrestres e a cada 6 meses nos cursos aquáticos" — a repetição parece erro de digitação | Regra de atestado sai da base: quem informa é o consultor |

> ✅ **Confirmado em 18/08/2026:** as formas de pagamento **se combinam** — dois
> cartões, entrada no PIX com saldo parcelado. O roteiro da objeção de limite de
> crédito voltou a oferecer as duas.

---

> **Estado em 20/08/2026:** os dois itens 🔴 no topo da lista abaixo — atendimento
> a PCD/TEA e os serviços de saúde e bem-estar — são os que travam resposta em
> conversa real. O de PCD já apareceu numa conversa de teste, com um responsável
> decidindo matrícula. Tudo o mais que estava pendente de decisão sua foi
> respondido nesta data.

## O que ainda falta na base

Conferido arquivo por arquivo em 19/08/2026: **não existe mais nenhum `PENDENTE`
de dado na base** — as únicas ocorrências da palavra são as notas que explicam a
marcação. Endereço e contatos, aula experimental, matrícula, estrutura,
diferencial de cada atividade, Hidro Zen, feriados e vigência de preços foram
todos preenchidos.

Sobrou pouco, e nada que trave uma venda:

| Prioridade | Dado | Onde |
|---|---|---|
| 🔴 | **Atendimento a PCD, e a criança com TEA ou outra necessidade específica** | `informacoes-gerais.md` — já apareceu numa conversa de teste (id40, 20/08) e o agente teve de transferir. É pergunta de mãe/pai decidindo matrícula, não curiosidade |
| 🔴 | **Serviços de saúde e bem-estar:** fisioterapia, hidroterapia, quiropraxia, massagem relaxante, liberação miofascial, drenagem linfática, acupuntura — a academia oferece? É à parte do plano? Quanto custa? | `informacoes-gerais.md` — hoje está tudo `PENDENTE` e o agente transfere em qualquer uma dessas |
| ✅ | ~~Descontos: família, matrícula antecipada, convênio empresa~~ — respondido em 20/08/2026 | `planos-e-valores.md` seção 4: 65+ e família de 3 ou mais, 10%, sem acúmulo e sem negociação |
| ⚪ | Quais sessões de musculação são as de 11–12 anos (a grade não marca) | `grade-horaria.md` — hoje o agente cita a faixa sem apontar o horário |
| ⚪ | Diferencial das aulas coletivas terrestres (Hatha Ioga, GAP, Power Local, Cycling, Ritmos, Boxe) | `atividades.md` — as aquáticas e a musculação já têm; nessas o agente só descreve a aula |

> ⚠️ **Este parágrafo ficou desatualizado.** Ele dizia que "piscina aquecida e
> coberta" e "turmas reduzidas" tinham sido *retiradas* da base por não estarem
> confirmadas. A piscina voltou depois, com dado firme: `informacoes-gerais.md`
> descreve 15 m, coberta e aquecida entre 30 e 30,5 °C, e a FAQ do mesmo arquivo
> confirma. **Vale o dado.** O aviso de "não confirmado" que sobrou na seção
> Estrutura é que precisa sair — hoje ele só faz o agente hesitar num diferencial
> forte. Sobre tamanho de turma segue valendo o número real da base da natação
> infantil (até 5 / 6 / 10), nunca a lotação do horário na grade.

---

## 🟡 Contradições dentro da base — 19/08/2026

Diferente das lacunas acima: aqui o dado **existe em dois arquivos com valores
diferentes**, e o agente escolhe um por sorteio sem avisar. Detalhe e correção
em [REVISAO-PROMPT.md](REVISAO-PROMPT.md), bloco 3.

| Contradição | Onde | O que vale |
|---|---|---|
| ✅ Agendamentos simultâneos — resolvido em 20/08/2026 | corrigido no `gerar-grade-horaria.js` e no `.md` | **3 no total, no máximo 1 por modalidade** (`operacional-adulto.md`, `suporte-fiti.md`) |
| ✅ Duração da aula — resolvido em 20/08/2026 | seção própria na grade, fora de "não invente" | **45 min** adultas e coletivas |
| ✅ Idade da natação bebê — resolvido em 20/08/2026 | corrigido no `gerar-grade-horaria.js` | **de 12 meses até entre 3,5 e 4 anos** |
| ✅ Piscina aquecida — resolvido em 20/08/2026 | a nota que desmentia saiu da seção Estrutura | o dado: 15 m, coberta, 30–30,5 °C |

⚠️ **As duas primeiras vivem em `scripts/gerar-grade-horaria.js`**, não no `.md`.
Corrigir só o markdown seria desfeito no próximo `npm run grade`.

**Falta um mapeamento:** `planos-e-valores.md` define frequência por Iniciante /
Intermediário / Aperfeiçoamento (2 / 3 / 5 sessões), a base infantil fala em
Golfinho I / N3 Amarela / N5 Laranja, e nenhum arquivo liga os dois vocabulários.
"Meu filho está no N3, quantas vezes por semana ele nada?" hoje exige três saltos
de inferência.

**Vigência da tabela — resolvido em 20/08/2026:** a tabela adulto vale. Quando o
agente entrar em conversas reais ela já estará em vigor. E a regra geral: **o
agente não deve saber de vigência de tabela nenhuma** — a tabela que está na
base é, por definição, a que vale. A linha de vigência saiu do cabeçalho do
`planos-e-valores.md`.

---

## 🔴 Bloqueiam o roteiro de venda

O prompt manda usar estes conteúdos. Sem eles, a conversa trava exatamente no
ponto mais forte do roteiro.

| Conteúdo | Situação |
|---|---|
| ~~Metodologia da natação infantil, por nível~~ | ✅ Resolvido — `base-conhecimento-natacao-infantil.md` cobre as duas trilhas, nível a nível, com respostas prontas para objeções. |
| ~~Anamnese em versão enxuta~~ | ✅ Resolvido — `anamnese-perfil-cliente.md`. |
| ~~Diferenciais de cada aula aquática~~ | ✅ Resolvido — natação adulto, bebê, hidroginástica e Hidro Zen têm a linha "Diferencial na AP" preenchida em `atividades.md`. Falta só nas coletivas terrestres. |

---

## 🟡 Informação repetida em mais de um arquivo

Critério aplicado: **o prompt diz o que fazer, a base diz o que é verdade.**

| Repetido em | Situação |
|---|---|
| Regras operacionais adulto — `vendas.md` × `planos-e-valores.md` | ✅ Consolidado em `operacional-adulto.md` |
| FITI 48h, cancelamento 1h, falta = 2 dias sem agendar | ✅ Saiu do prompt, virou base |
| "Dor não troca a modalidade" — `vendas.md` §5 e `anamnese` §7, quase palavra por palavra | ⚠️ Ainda duplicado. Manter na anamnese e deixar só a instrução no prompt |
| "Acompanhamento técnico incluso" — `vendas.md`, `planos-e-valores.md`, `anamnese` §6, `atividades.md` | ⚠️ Aceitável enquanto o texto-fonte for o de `planos-e-valores.md` |

**Peso no contexto:** a base inteira vai em toda resposta. A base da natação
infantil sozinha é quase metade dela e só interessa quando o lead é pai ou mãe —
ver a nota sobre carregamento condicional em [HANDOFF.md](HANDOFF.md).

---

## ⚪ Notas de fechamento do pente fino

- **Hidroginástica** existe e está na grade — 7 horários, de segunda a sábado.
  A tabela de planos a cobre dentro de "Atividades Aquáticas".
- **Funcional Kids** também está na grade (Seg/Qua 08:45 e 18:20, Ter/Qui 16:25).
- **`desktop.ini`** removido da pasta de conhecimento e adicionado ao
  `.gitignore` — era resíduo de sincronia do OneDrive.
- O `guard` do `ai-agent.js` passou a reconhecer **`PENDENTE`** e `_preencha_`
  como dado indisponível. Antes ele só conhecia "Exemplo", "XXX" e
  "descreva aqui", então os placeholders `_preencha_` da base antiga
  atravessavam o filtro.

---

## Decisões suas, não informação

| Assunto | Situação |
|---|---|
| Nome da consultora virtual | Definido: **Leia** |
| O bot pode fechar venda? | Hoje não fecha nem cadastra — coleta e transfere. As tools de cadastro e agendamento estão pausadas. |
| Tom | Definido: levemente descontraído, consciente da responsabilidade de conduzir à contratação |

---

## Primeira rodada de testes — 19/08/2026

A página `/teste` entrou no ar na VPS e as primeiras conversas foram gravadas.
Números da rodada (`npm run conversas -- --canal=web-test`): **3 conversas, 34
mensagens, 3 em 3 terminando em handoff**.

Os motivos — e a releitura depois da auditoria de
[REVISAO-PROMPT.md](REVISAO-PROMPT.md):

| Motivo do handoff | Registrado como | Releitura |
|---|---|---|
| Dificuldade de agendamento no app FITI (2x) | O bot não enxerga agenda nem cadastro — o prompt manda transferir | **Correto** para "não consigo entrar no app". Mas a regra não distingue isso de "como funciona o agendamento?", que é pergunta de venda |
| Negociação da taxa de adesão de R$ 184 (2x) | Financeiro é transferência imediata por regra | **Regra disparando cedo demais.** "Negociação" no item Financeiro captura objeção de preço de lead novo — e o próprio prompt tem a resposta: o Anual é isento da adesão |
| Marcar aula experimental de natação infantil | Quem agenda é o consultor (`informacoes-gerais.md`) | **Instrução desatualizada.** O `vendas.md` ainda diz que as condições da aula experimental são `PENDENTE`; a base já responde que existe e é gratuita. O agente transfere com "não sei" onde deveria escolher o horário e transferir com o lead pronto |

**A leitura original** era que o bot não estava errando, só esbarrando no limite
do que lhe foi permitido fazer. Vale em parte: como só o humano agenda, **todo
lead bem conduzido termina em handoff**, e handoff não avisa ninguém — por isso a
notificação segue como primeiro item da lista abaixo.

**O que a leitura original não viu:** dois dos três motivos são texto corrigível,
não limite de escopo. Antes de investir em notificação, vale aplicar o bloco 1 de
`REVISAO-PROMPT.md` e rodar os testes de novo — a taxa de handoff da próxima
rodada é a medida de se o ajuste funcionou.

As transcrições ficam em `data/conversas/` (fora do git). Regenere quando
precisar; o histórico vive no Supabase.

## Pendências que não são conteúdo

Para não perder de vista — detalhamento em [HANDOFF.md](HANDOFF.md).

- 🔴 **Handoff grava no banco mas não notifica ninguém.** Sem alguém olhando
  `/admin/handoffs`, o cliente transferido fica sem resposta. Com 100% das
  conversas de teste terminando em handoff, é hoje a maior lacuna para uso real.
- ⚠️ `EVOLUTION_SERVER_URL` ainda em `localhost:8080` no `.env` da VPS, e o
  container `evolution-api` está em loop de restart — o canal WhatsApp está fora
  do ar. As chaves de Anthropic e Supabase da VPS foram resolvidas em 19/08.
- ⚠️ Webhook da Evolution configurado no compose, mas **nunca testado** com uma
  instância real — o fluxo inbound do WhatsApp segue não verificado.
- ⚪ Página `/teste` no ar com a senha padrão `Leia`, em HTTP puro. Desligue com
  `TESTE_HABILITADO=false` quando a rodada de testes terminar.
