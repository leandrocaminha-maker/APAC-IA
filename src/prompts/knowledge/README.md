# Pasta de Conhecimento do Agente IA

Todos os arquivos `.md` desta pasta (menos este README) são concatenados e
enviados no contexto do agente **a cada resposta**. O cache recarrega sozinho a
cada 5 minutos, ou na hora com `POST /admin/reload-cache`.

## Divisão de responsabilidade

**O prompt (`src/prompts/vendas.md`) diz como conduzir. A base diz o que é
verdade.** Quando um dado aparece nos dois lugares, o dia em que ele mudar um
dos dois vira mentira — por isso o prompt referencia a base em vez de repeti-la.

| Arquivo | O que vive nele |
|---|---|
| `informacoes-gerais.md` | Nome, endereço, contatos, horário de funcionamento, estrutura, matrícula, políticas do dia a dia, FAQ |
| `planos-e-valores.md` | Planos, preços, o que cada um inclui, taxa de adesão, Clube Sábado |
| `operacional-adulto.md` | Regras de uso do plano adulto: agendamento FITI, PAR-Q, suspensão, devolução em 21 dias, cancelamento |
| `contrato-resumo.md` | Síntese do contrato: cancelamento, rescisão, transferência, férias, atestado, vestuário, uso de imagem, convivência |
| `atividades.md` | O que é cada aula e qual o diferencial dela |
| `grade-horaria.md` | Dias e horários das turmas — **gerado automaticamente** |
| `base-conhecimento-natacao-infantil.md` | Metodologia, níveis e objeções da Escola de Natação Infantil e Bebês |
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

**Exceção: `grade-horaria.md` não se edita à mão.** Ele é gerado de
`data/grade-aulas.csv`. Para atualizar a grade, substitua o CSV pela nova
exportação do sistema e rode `npm run grade`; qualquer edição manual no `.md` é
desfeita na próxima geração.

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
