# Pasta de Conhecimento do Agente IA

Os arquivos `.md` desta pasta são enviados no contexto do agente **por
módulo**, não todos de uma vez. O cache recarrega sozinho a cada 5 minutos, ou
na hora com `POST /admin/reload-cache`.

## Módulos — o que vai em qual conversa

Até 24/08/2026 a pasta inteira ia junto em toda mensagem: 38.038 tokens, o que
fazia os 9.647 tokens de metodologia da natação infantil viajarem junto de quem
perguntou o preço da musculação. Agora a composição é esta (definida em
[`src/services/knowledge.js`](../../services/knowledge.js)):

| Módulo | Arquivos | Quando entra |
|---|---|---|
| `nucleo` | `informacoes-gerais`, `planos-e-valores`, `atividades`, `grade-horaria` | **Sempre** |
| `adulto` | `anamnese-perfil-cliente`, `operacional-adulto` | Por padrão — **menos** na conversa exclusivamente infantil |
| `infantil` | `base-conhecimento-natacao-infantil`, `grade-horaria-infantil` | Sinal de criança na conversa |
| `infantil-tecnico` | `natacao-infantil-tecnico` | **Só pela tool `carregar_base`** |
| `matriculado` | `conducao-matriculado`, `suporte-fiti` | Sinal de aluno/suporte, ou `is_prospect = false` |

Em 26/08/2026 duas coisas mudaram, ambas para tirar peso de quem não precisa
dele:

- O `adulto` deixou de ser incondicional. Ele carrega 7.225 tokens de
  qualificação e regras de público 13+ — e a própria `anamnese-perfil-cliente`
  abre dizendo que vale "a partir de 13 anos". Quem só falou do filho de 4 anos
  não recebe mais isso. Basta um sinal adulto na conversa (`SINAIS_ADULTO`, ou
  uma idade de 13 para cima) para ele voltar.
- A base infantil, que era um arquivo de 9.647 tokens, virou dois: o que a
  venda usa (turmas, ponto de entrada, objetivo de cada nível, objeções) e o
  embasamento da metodologia, que só entra quando o responsável pergunta como o
  programa funciona por dentro.
- Pelo mesmo motivo, a **grade** virou dois arquivos: `grade-horaria.md` no
  núcleo, com as atividades 13+, e `grade-horaria-infantil.md` no módulo
  `infantil`. Eram 1.892 tokens de horário de criança em toda conversa. Quem
  decide o arquivo de cada seção é o campo `publico` em
  [`scripts/gerar-grade-horaria.js`](../../../scripts/gerar-grade-horaria.js).

A detecção lê a conversa inteira que está na janela de histórico, não só a
última mensagem — e erra para o lado de **carregar demais** de propósito.
Quando ela erra para menos, o próprio agente pede o módulo que falta com a tool
`carregar_base`, e ele fica travado naquela conversa
(`wa_conversations.context.knowledge`).

> ⚠️ **Arquivo novo nesta pasta NÃO entra sozinho.** Ele precisa ser listado em
> um módulo dentro de `knowledge.js`. É proposital: varrer o diretório foi
> exatamente o que fazia todo arquivo novo virar custo em toda conversa sem
> ninguém decidir isso. Se você criou um `.md` aqui e o agente não o enxerga, é
> isto.

O **follow-up** ([`src/prompts/followup.md`](../followup.md)) não carrega
módulo nenhum — ver o cabeçalho daquele arquivo.

## Divisão de responsabilidade

**O prompt (`src/prompts/vendas.md`) diz como conduzir. A base diz o que é
verdade.** Quando um dado aparece nos dois lugares, o dia em que ele mudar um
dos dois vira mentira — por isso o prompt referencia a base em vez de repeti-la.

| Arquivo | O que vive nele |
|---|---|
| `informacoes-gerais.md` | Nome, endereço, contatos, horário de funcionamento, estrutura, matrícula, políticas do dia a dia, FAQ |
| `planos-e-valores.md` | Planos, preços, o que cada um inclui, taxa de adesão, Clube Sábado |
| `operacional-adulto.md` | Regras de uso do plano adulto: agendamento FITI, PAR-Q, suspensão, devolução em 21 dias |
| `conducao-matriculado.md` | Como conduzir o aluno matriculado, mais os fatos do contrato: rescisão, transferência, uso de imagem, convivência, canais |
| `atividades.md` | O que é cada aula e qual o diferencial dela |
| `grade-horaria.md` | Dias e horários das turmas 13+ — **gerado automaticamente** |
| `grade-horaria-infantil.md` | Dias e horários das turmas infantis e de bebê, e a regra do par de dias — **gerado automaticamente** |
| `base-conhecimento-natacao-infantil.md` | Turmas, ponto de entrada, objetivo de cada nível e objeções da Escola de Natação Infantil e Bebês |
| `natacao-infantil-tecnico.md` | O embasamento da metodologia infantil: fases, conteúdo por nível, metas de promoção, glossário |
| `anamnese-perfil-cliente.md` | Qualificação: as perguntas que mudam a recomendação e a leitura de cada resposta |

## Como editar

1. Abra o arquivo da tabela acima e substitua o dado.
2. Salve. **Localmente** o agente recarrega em até 5 minutos.
3. **Para valer na VPS, precisa de deploy**: estes arquivos são copiados para
   dentro da imagem Docker, então `git push` na sua máquina e, na VPS,
   `git pull && docker compose up -d --build backend`. O recarregamento de 5
   minutos relê o disco do container — que continua com a versão do último
   build até você reconstruir.

> Isto vale para os knowledge files. O **prompt** (`src/prompts/vendas.md`) vive
> no banco e segue outro caminho: `npm run prompt`, sem deploy. Ver `HANDOFF.md`.

**Exceção: os dois `grade-horaria*.md` não se editam à mão.** Ambos são gerados
de `data/grade-aulas.csv` pelo mesmo script. Para atualizar a grade, substitua o
CSV pela nova exportação do sistema e rode `npm run grade`; qualquer edição
manual nos `.md` é desfeita na próxima geração. Para mudar em qual arquivo uma
atividade sai, mexa no campo `publico` da seção dela em
`scripts/gerar-grade-horaria.js`.

## A marcação `PENDENTE`

Dado que ainda não existe se escreve **`PENDENTE`**, nunca com um valor
plausível no lugar. O agente é instruído a tratar `PENDENTE` como informação
indisponível e transferir para um consultor humano em vez de responder.

Um placeholder que parece um dado real (um endereço de exemplo, uma temperatura
"aproximada") é pior que a lacuna: o guard não pega, e o bot afirma ao cliente.

## O que não vai nesta pasta

- **Regras de conduta do bot** (tom, formatação de WhatsApp, quando transferir):
  ficam no prompt, não aqui.
- **Dados individuais de aluno** (cadastro, pagamento, agenda): o agente não
  enxerga nada disso — o caminho é `transferir_para_humano`.
