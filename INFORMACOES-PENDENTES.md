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

## 🔴 Preencher em `informacoes-gerais.md` e `operacional-adulto.md`

O arquivo existe e está estruturado; o que falta está marcado `PENDENTE` e o
agente já sabe transferir em vez de inventar. Por ordem de quanto custa por dia:

| Prioridade | Dado | Onde |
|---|---|---|
| 🔴 | Endereço, telefone, Instagram, site | `informacoes-gerais.md` |
| 🔴 | **Aula experimental** — existe? é gratuita? como agenda? o que levar? | `informacoes-gerais.md` — o roteiro de vendas já a oferece no fechamento |
| 🟡 | Como funciona a matrícula, documentos, prazo | `informacoes-gerais.md` |
| ⚪ | Estrutura: piscinas, aquecimento e temperatura, estacionamento, acessibilidade | `informacoes-gerais.md` |
| ⚪ | Diferencial de cada atividade (as linhas "Diferencial na AP") | `atividades.md` |
| ⚪ | O que é a aula Hidro Zen & Meditação | `atividades.md` — hoje ninguém sabe, e o nome não basta |
| ⚪ | Horário de feriados | `informacoes-gerais.md` |
| ⚪ | Vigência dos preços (tabela infantil é de Janeiro/2026) | `planos-e-valores.md` |
| ⚪ | Descontos: família, matrícula antecipada, convênio empresa | `planos-e-valores.md` |
| ⚪ | Quais sessões de musculação são as de 11–12 anos (a grade não marca) | `grade-horaria.md` |

> Duas afirmações antigas seguem **não confirmadas** e foram retiradas da base:
> "piscina aquecida e coberta" e "turmas reduzidas" como slogan. Sobre tamanho
> de turma, o número real está na base da natação infantil (até 5 / 6 / 10).

---

## 🔴 Bloqueiam o roteiro de venda

O prompt manda usar estes conteúdos. Sem eles, a conversa trava exatamente no
ponto mais forte do roteiro.

| Conteúdo | Situação |
|---|---|
| ~~Metodologia da natação infantil, por nível~~ | ✅ Resolvido — `base-conhecimento-natacao-infantil (2).md` cobre as duas trilhas, nível a nível, com respostas prontas para objeções. |
| ~~Anamnese em versão enxuta~~ | ✅ Resolvido — `anamnese-perfil-cliente.md`. |
| **Diferenciais de cada aula aquática** | ❌ Continua faltando. O prompt manda "mostre como são as aulas e seus diferenciais" para natação adulto, bebê e hidroginástica — só a infantil tem esse conteúdo hoje. Para as outras três o bot cita o nome da modalidade e vai direto ao preço. |

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

## Pendências que não são conteúdo

Para não perder de vista — detalhamento em [HANDOFF.md](HANDOFF.md).

- `.env` da VPS: `ANTHROPIC_API_KEY`, `ADMIN_API_KEY`, `EVOLUTION_SERVER_URL`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Webhook da Evolution configurado no compose, mas **nunca testado** com uma
  instância real — o fluxo inbound do WhatsApp segue não verificado
- Handoff grava no banco mas **não notifica ninguém**: sem alguém olhando
  `/admin/handoffs`, o cliente transferido fica sem resposta. É a lacuna mais
  relevante para uso real, e cresce em importância a cada item desta lista que
  continuar pendente.
