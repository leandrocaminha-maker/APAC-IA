# Informações Gerais — AP Academia

> Dados institucionais e regras do dia a dia. É aqui que o agente busca
> endereço, contato, horário de funcionamento, matrícula e políticas.
>
> **Marcação `PENDENTE`:** o dado ainda não existe. O agente está proibido de
> preencher a lacuna por conta própria — nesses casos ele transfere para um
> consultor. Substitua o `PENDENTE` pelo dado real e ele passa a responder.
>
> Não coloque aqui: preços (`planos-e-valores.md`), horários de turma
> (`grade-horaria.md`), regras de plano adulto (`operacional-adulto.md`),
> metodologia infantil (`base-conhecimento-natacao-infantil.md`), nem regras de
> conduta do bot (essas ficam no prompt, não na base).

## Identidade

- **Nome:** AP Academia
- **O que é:** uma **academia completa** — musculação, aulas coletivas,
  atividades aquáticas, Pilates Fit Studio e Escola de Natação Infantil e Bebês.
  Não descreva a AP como "academia de natação": natação é uma das frentes, não
  o negócio inteiro.

## Contato e canais

| Canal | Dado |
| --- | --- |
| Endereço | Rua Ribeirão Vermelho, 459 - Pirituba - São Paulo SP |
| Ponto de referência / como chegar | Ao lado da UBS Vila Boaçava |
| Telefone | 11 94071-5006 |
| WhatsApp de atendimento | 11 94071-5006 |
| Instagram | @apacademia |
| Site | <www.apacademia.com.br> |

## Horário de funcionamento

| Dia | Abertura | Fechamento |
| --- | --- | --- |
| Segunda a sexta | 06:00 | 12:30 |
| Segunda a sexta (tarde/noite) | 15:00 | 22:00 |
| Sábado | 08:30 | 13:00 |
| Domingo | Não abre | — |
| Feriados | Não abre | — |

**A academia fecha das 12:30 às 15:00**, de segunda a sexta. Isso é informação
de venda, não detalhe: quem só pode treinar no horário de almoço não é atendido,
e é melhor dizer isso na hora do que descobrir depois da matrícula.

**Domingo não abre.** Para quem só tem o fim de semana livre, o caminho é o
Clube Sábado (`planos-e-valores.md`).

Horário de funcionamento não é o mesmo que horário de aula — as turmas estão em
`grade-horaria.md`, e a última aula da noite começa às 21:00.

**Janela para contato ativo:** follow-up, retomada de conversa e qualquer
chamada partindo da academia acontecem **somente das 9h00 às 20h30**. Fora dessa
faixa não se inicia contato — responder quem escreveu é outra coisa, e vale a
qualquer hora.

**É também a faixa em que o consultor humano responde.** Repare que ela não
coincide com o funcionamento: às 7h a academia está aberta e o consultor ainda
não atende; às 21h ainda há aula acontecendo e ele já não atende. Ao dizer a
alguém fora do expediente quando terá resposta, vale a **primeira hora em que as
duas coisas valem** — academia aberta E dentro de 9h–20h30.

## Estrutura

- Piscina: piscina de 15m coberta e aquecida, 4 raias, mantida entre 30 e 30,5 graus celsius. Tratamento comOzônio. Uso de controle eletrônico de paramentros de qualidade.
- Sala de musculação: temos uma sala bem versátil para prestigiar o trabalho dos professores e atender diversas demandas, aparelhos de alto desempenhbo em conjunto com unidades bem adaptáveis para todos os níveis de alunos. O espaço funcional possui kit de LPO, kettlebells, TRX, medicine ball, cordas, caixas, bosu. Tem um gramado ao ar livre que deixa o treino mais gostoso.
- Sala de aulas coletivas
_estúdio de Pilates
- Tatame para lutas e Funcional Kids
- Sala de Bike Indoor
- Vestiários masculino e feminino
- Recepção
- Estacionamento
- Acessibilidade: a maioria dos espaçõs são no térreo, incluindo piscina e musculação.

## Aula experimental

- Existe? Sim e é desejavel que o cliente agende para firmar compromisso de ir até a academia e experimente a aula antes de fechar plano.
- É gratuita? Sim
- Como agenda? **A própria Leia agenda**, na conversa, seguindo o protocolo "Agendamento de aula experimental" do prompt. Desde 22/08/2026 não depende mais de consultor.
- O que a pessoa precisa levar? roupa de ginástica, tênis e equipamento da modalidade. Regras de vestuário (proibido jeans, saia, chinelo, salto; touca e maiô/sunga obrigatórios na piscina) em `contrato-resumo.md`.

> O agente explica que a aula experimental existe e é gratuita, ajuda a achar o
> horário na grade **e conclui o agendamento**, com as tools `buscar_cadastro`,
> `cadastrar_prospect` e `agendar_aula_experimental`.
>
> `transferir_para_humano` aqui virou exceção, não regra: só quando o
> agendamento não for possível (turma cheia, horário fora da grade que a pessoa
> não aceita trocar, sistema recusando) ou quando quem pede **é aluno ativo** —
> a aula experimental é do fluxo de oportunidade, não de matriculado.

## Ex-aluno que volta

**Quem está sem contrato há mais de 3 meses volta à condição de lead** e pode
fazer aula experimental normalmente, como qualquer oportunidade nova.

⚠️ O EVO **não** faz esse caminho de volta sozinho: lá, uma vez `member`,
sempre `member` — mesmo sem contrato desde 2021. Quem aplica a regra é a Leia,
pela tool `buscar_cadastro`, que cruza o status do cadastro com a data de fim do
último contrato.

Na prática o próprio EVO concorda: tentar matricular um aluno inativo numa aula
devolve *"Agendamento indisponível pelo motivo: Inactive member"*. Por isso o
retorno é registrado como oportunidade nova, com o número do cadastro antigo
anotado para o consultor ver o histórico.

Quem parou há **menos** de 3 meses é caso de **retenção**, não de lead novo:
aí vale o consultor.

## Matrícula

- Como é feita - presencial pelo consultor.
 Documentos necessários: Qualquer documento de identificação válido com foto. Para menores de 18 anos, é necessário documento de identificação dos pais ou responsáveis.
- Prazo entre matrícula e primeira aula: Imediato

Para as regras de plano adulto — adesão, agendamento, suspensão, devolução —
veja `operacional-adulto.md`.

## Convênios e agregadores

| Assunto | Regra |
| --- | --- |
| Quem é aceito | **Somente Totalpass, a partir do plano TP4.** Wellhub (Gympass) e demais agregadores não são aceitos hoje. |
| Como agenda | Pelo app do próprio agregador. |
| Primeira visita | Chegar à academia **30 minutos antes** da atividade para completar cadastro, assinar o termo e configurar a biometria. |

Quem chega por agregador é atendido normalmente — é lead como qualquer outro, e
vale apresentar os planos quando fizer sentido.

## Políticas do dia a dia

| Assunto | Política |
| --- | --- |
| Falta e reposição de aula | não há reposição de aulas perdidas, exceto em casos de força maior com apresentação de atestado médico. Vale para adulto e infantil. Os tíquetes extras dos níveis Intermediário e Aperfeiçoamento (`contrato-resumo.md`) são sessões a mais na semana, não reposição de falta. |
| Troca de horário de turma | depende de **disponibilidade de vaga** e da **liberação técnica do professor**. Na infantil o professor também avalia a adaptação da criança ao novo grupo — é avaliação técnica dele, não pedido administrativo. |
| Cancelamento de contrato | `contrato-resumo.md` — muda conforme o plano (Assinatura, Anual, Mensal) |
| Atraso na chegada à aula | como regra geral 10 minutos, porém fica a critério do professor. |
| Acompanhante na aula infantil | na natação bebê o responsável entra na água, nas primeiras aulas de crianças inseguras o responsável pode acompanhar do deck. |
| Objeto esquecido | há uma **caixa de achados e perdidos** para itens comuns; **objetos de valor ficam guardados na recepção**. |

## Atendimento a PCD e necessidades específicas

- **Atendimento a pessoa com deficiência, e a criança com TEA ou outra
  necessidade específica:** `PENDENTE`. Não afirme que a academia atende nem que
  não atende, e não descreva adaptação nenhuma — transfira para um consultor.
  A estrutura física acessível está descrita em Estrutura, acima, e isso você
  pode informar; o que falta é a política de atendimento.

## Serviços de saúde e bem-estar

Se a academia oferece, se é à parte do plano, e quanto custa: **tudo `PENDENTE`**
para a lista abaixo. Não afirme que existe nem que não existe — transfira.

Fisioterapia · Hidroterapia · Quiropraxia · Massagem relaxante · Liberação
miofascial · Drenagem linfática · Acupuntura

Não confunda com as atividades da grade (`atividades.md`), que são aulas, nem com
o **acompanhamento técnico** incluso no plano (`planos-e-valores.md`), que é
avaliação física, plano de treino e reavaliações com os professores.

## Perguntas frequentes

**Preciso saber nadar?**
Não. Há turmas para todos os níveis, incluindo quem nunca entrou na piscina —
tanto no infantil (turma de Adaptação) quanto no adulto.

**A academia fecha no meio do dia?**
Sim, das 12:30 às 15:00, de segunda a sexta.

**Meu filho começa em que nível?**
O nível é definido por idade e experiência, e confirmado na avaliação da
primeira aula. Ver `base-conhecimento-natacao-infantil.md`.

**A piscina é aquecida?**
Sim

**Tem estacionamento?**
Sim
