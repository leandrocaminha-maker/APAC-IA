# Informações pendentes — o que o bot ainda não sabe

> Levantado durante a construção e os testes de 15/08/2026.
> Cada item diz **onde vai**, **por que importa** e **o que acontece hoje sem ele**.
>
> Regra geral: enquanto o dado não estiver num arquivo de
> `src/prompts/knowledge/`, o agente transfere para humano em vez de responder.
> Isso é o comportamento seguro — mas cada transferência dessas é uma venda que
> não avançou sozinha.

---

## 🔴 Corrigir primeiro — risco de informação errada

Estes não estão "faltando": estão **preenchidos com suposição**. O agente afirma
como verdade, e o guard não pega porque não estão marcados como exemplo.

| Item | Onde | Situação |
|---|---|---|
| Nome da empresa | `informacoes-gerais.md` | Diz "AP Academia de Natação e Hidroginástica" — mas é academia completa. Subvende o negócio logo na apresentação. |
| "Piscina aquecida e coberta" | `informacoes-gerais.md` | Nunca confirmado. |
| "Turmas reduzidas" | `informacoes-gerais.md` | Nunca confirmado. |
| "O que trazer na aula experimental: traje, toalha, chinelo e documento com foto" | `informacoes-gerais.md` | **Inventado.** O bot vai instruir o cliente com isso. |
| "Temperatura entre XX°C e XX°C" | `informacoes-gerais.md` | Placeholder dentro de uma frase afirmativa. |
| Vigência dos preços | `planos-e-valores.md` | Tabela marcada Janeiro/2026, estamos em agosto. Confirmar se ainda valem. |

---

## 🔴 Bloqueiam o roteiro de venda

O prompt manda usar estes conteúdos. Sem eles, a conversa trava exatamente no
ponto mais forte do roteiro.

### Metodologia da natação infantil, por nível

**Onde:** novo arquivo `metodologia-natacao.md`
**Por quê:** o prompt manda apresentar trechos da metodologia para iniciante e,
separadamente, para intermediário/aperfeiçoamento — é o que convence pai e mãe.
**Hoje:** o bot pergunta a idade e se já sabe nadar, e então não tem o que dizer.

Precisa de: o que a criança faz e conquista em cada nível, em linguagem de pai,
não de técnico. Uns 3 a 5 parágrafos curtos por faixa.

### Anamnese em versão enxuta

**Onde:** novo arquivo `anamnese-resumida.md`
**Por quê:** o prompt manda usá-la para ligar objetivo declarado à solução.
**Hoje:** a etapa "o que motivou você a procurar agora" não tem apoio nenhum.

Precisa de: as perguntas que um consultor não-técnico faria, e o que cada
resposta sugere de encaminhamento.

### Diferenciais de cada aula aquática

**Onde:** `informacoes-gerais.md` ou o de metodologia
**Por quê:** o prompt manda "mostre como são as aulas e seus diferenciais" para
natação adulto, infantil, bebê e hidroginástica.
**Hoje:** ele cita o nome da modalidade e passa direto para o preço.

---

## 🔴 Perguntados no teste, sem resposta

Estes apareceram como handoff em conversas de teste — são o básico que qualquer
interessado pergunta.

| Informação | Onde |
|---|---|
| **Endereço** | `informacoes-gerais.md` |
| **Horário de funcionamento** (dias e faixas) | `informacoes-gerais.md` |
| **Telefone / Instagram / site** | `informacoes-gerais.md` |
| **Grade horária das turmas** | `grade-horaria.md` — hoje 100% placeholder |

---

## 🟡 Fecham a venda

| Informação | Onde | Por quê |
|---|---|---|
| **Aula experimental existe?** Gratuita? Como agenda? | `informacoes-gerais.md` | É o próximo passo clássico. O prompt não a menciona hoje justamente porque não há dado. |
| **Formas de pagamento** | `planos-e-valores.md` | Pergunta frequente antes de fechar. |
| **Descontos** — família, matrícula antecipada, convênio empresa | `planos-e-valores.md` | O arquivo original previa esses campos, todos vazios. |
| **Política de cancelamento de contrato** | `planos-e-valores.md` | Diferente do afastamento com atestado, que já está documentado. |
| **Como funciona a matrícula** | `informacoes-gerais.md` | Presencial? Online? O que levar? |
| **Política de reposição de falta** | `informacoes-gerais.md` | FAQ com placeholder. |
| **Troca de horário** | `informacoes-gerais.md` | FAQ com placeholder. |

---

## ⚪ Complementares

| Informação | Onde |
|---|---|
| Estrutura: nº de piscinas, dimensões, estacionamento, acessibilidade | `informacoes-gerais.md` |
| Idade mínima da musculação (a tabela cita 11–12 anos no combo kids) | `planos-e-valores.md` |
| Grade do Funcional Kids e da Musculação infantil | `grade-horaria.md` |
| Hidroginástica está na grade? | — |

> Sobre a hidroginástica: o prompt e o arquivo de informações a citam pelo nome,
> mas a tabela de planos chama a categoria de "Atividades Aquáticas" e não a
> lista em lugar nenhum. Se ela não existe mais, sai dos dois; se existe,
> precisa aparecer na grade.

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
