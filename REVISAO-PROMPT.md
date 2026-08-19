# Revisão do prompt e da base — achados de 19/08/2026

> Auditoria do `vendas.md`, dos 8 knowledge files e do caminho de código que
> monta o system prompt, feita depois da primeira rodada de testes pela página
> `/teste`. É uma **lista de correções pendentes**, não um relatório: cada item
> diz onde está, por que importa e o que fazer.
>
> Nada aqui foi aplicado. Ver [HANDOFF.md](HANDOFF.md) para o estado do
> projeto e [INFORMACOES-PENDENTES.md](INFORMACOES-PENDENTES.md) para as
> lacunas de conteúdo da base.
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
| 1 | Regras de handoff + aula experimental | `src/prompts/vendas.md` | `npm run prompt` |
| 2 | Data/hora e bloco de contato | `src/services/ai-agent.js` | deploy na VPS |
| 3 | Contradições da base e do gerador da grade | `knowledge/*.md`, `scripts/gerar-grade-horaria.js` | deploy na VPS |
| 4 | Lacunas do roteiro (Clube Sábado, aluno matriculado) | `src/prompts/vendas.md` | `npm run prompt` |
| 5 | Campo `dados_coletados` no handoff | `src/services/ai-tools.js` | deploy na VPS |

Lembrete das duas armadilhas já conhecidas: **prompt só entra no banco pelo
`npm run prompt`**, e **knowledge file só chega na VPS por deploy** — editar o
arquivo local não muda nada no atendimento.

---

## 1. 🔴 Por que todo lead bem conduzido termina em handoff

Os três motivos registrados na rodada de 19/08 não são acaso: são quatro regras
do prompt disparando cedo demais. É o bloco de maior impacto na conversão.

### a) A regra da aula experimental está desatualizada

`vendas.md` (fim da matriz de objeções, ~linha 391) ainda diz que as condições da
aula experimental "estão PENDENTE" e manda transferir se a pessoa perguntar como
funciona. **Deixou de ser verdade:** `informacoes-gerais.md` já responde que
existe, é gratuita, o que levar, e que o consultor só faz o agendamento em si.

O agente está transferindo com "não sei" exatamente no ponto em que o roteiro
manda fechar.

**Correção:** confirmar que existe e é gratuita, **ajudar a escolher o horário na
grade**, e só então transferir — com atividade e horário já combinados no
`motivo`. É o mesmo handoff, com valor completamente diferente para o consultor.

### b) "Financeiro … negociação" captura objeção de preço de lead novo

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

### c) A regra do FITI se contradiz

O cabeçalho da seção diz "transferir **imediatamente, sem tentar resolver**"; o
item do FITI diz "apresente o processo padrão de agendamento e na sequência
transfira". Nas duas leituras o handoff acontece.

**Correção:** falta a distinção que importa — *"como funciona o agendamento?"* é
pergunta de venda (responde e segue); *"não consigo entrar no app / minha reserva
sumiu"* é conta (transfere).

### d) A regra guarda-chuva tem três reforços e nenhum contrapeso

"Qualquer dado que não esteja na base de conhecimento" (`vendas.md`) +
`NO_KNOWLEDGE_GUARD` (`ai-agent.js`) + a descrição da tool
`transferir_para_humano` (`ai-tools.js`) empurram todos para a mesma saída fácil.

**Correção:** acrescentar o contrapeso que hoje não existe em lugar nenhum —
*antes de transferir por falta de dado, verifique se a pergunta pode ser
respondida com o que existe; transfira só o que falta, sem encerrar a conversa.*

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

- **Clube Sábado não aparece uma única vez no `vendas.md`.** A base diz "antes de
  descartar um lead por indisponibilidade na semana, ofereça o Clube Sábado", mas
  a "Ordem de oferta" do prompt só conhece Performa / Aqua / Plus. Quem só pode
  sábado hoje ouve "não temos horário".
- **O fechamento das 12:30 às 15:00** é tratado pela base como informação de
  venda, e a etapa 4 do prompt (Disponibilidade) não pergunta nada a respeito.
  Descobrir isso depois da matrícula é churn.
- **Wellhub/Gympass aparecem no prompt** (frente 2, "convênio ou agregador") na
  frase que diz que agregador é atendido normalmente — mas a base é clara: só
  Totalpass, a partir do TP4. Basta tirar os nomes e deixar o ponteiro.
- **A frente 2 (aluno matriculado) não tem roteiro.** O prompt é ~95% venda. Como
  o WhatsApp de atendimento é o mesmo número principal da academia
  (11 94071-5006), quando o canal real entrar no ar **a maioria do volume será
  aluno, não lead** — e para esse público o prompt só oferece regras de
  transferência. É a maior lacuna de escopo para a virada de chave.

---

## 5. 🟡 Instruções que o modelo não consegue cumprir

### "Aguarde aproximadamente 10 segundos"

Na seção 6 (Apresentação dos planos e valores). O agente não tem relógio nem
indicador de digitação: responde uma vez por mensagem recebida. Na prática ou
ignora, ou verbaliza a espera, ou despeja Assinatura e Anual juntos — matando a
ancoragem que a regra queria proteger.

A intenção é boa e é uma regra de **turno**, não de segundos:

> Apresente a Assinatura e pare. O Anual só no turno seguinte, depois da reação
> dela. Se ela não reagir ao valor, aí sim puxe o Anual.

(Aproveite e corrija o "aroximadamente".)

### "menos que um cafezinho"

Está colado num exemplo que pode sair com R$ 9,90/dia (Estilo de Vida Plus). Em
São Paulo isso não sustenta a comparação e queima credibilidade no ponto mais
sensível da conversa. A instrução logo acima já é a certa — "associe a um item de
consumo diário de valor equivalente"; o exemplo é que precisa virar placeholder.

### Outros

- **"Seu trabalho tem duas frentes:"** seguido de três itens.
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

## O que foi conferido e está certo

A aritmética inteira da tabela de preços adulto — as 12 células de economia
mensal, economia anual e valor por dia — bate com os preços dos três planos e com
a taxa de adesão de R$ 184. É o dado de maior risco da base e está consistente.

## Pergunta para o Leandro

`planos-e-valores.md` diz "tabela adulto reformulada em **Setembro/2026**" —
data futura em relação a 19/08/2026. **Se a tabela ainda não entrou em vigor, o
agente está cotando preço que não vale.** Confirmar a vigência.
