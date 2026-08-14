# Pasta de Conhecimento do Agente IA

Todos os arquivos `.md` nesta pasta são carregados automaticamente pelo agente de IA
e incluídos no contexto do prompt quando ele atende um cliente no WhatsApp.

## Como editar

1. **Abra o arquivo** que deseja editar (planos, horários, informações gerais)
2. **Substitua os exemplos** pelos dados reais da academia
3. **Salve o arquivo** — o agente recarrega automaticamente a cada 5 minutos

## Quando usar arquivos vs. API do EVO

| Dado | Arquivo (estático) | API do EVO (dinâmico) |
|------|-------------------|----------------------|
| Planos e valores | ✅ Mais preciso, você controla o texto | ✅ Dados em tempo real |
| Grade horária | ✅ Formatação personalizada | ✅ Sempre atualizado |
| FAQ / Regras | ✅ Único lugar | ❌ Não existe no EVO |
| Vagas disponíveis | ❌ Pode ficar desatualizado | ✅ Sempre atual |
| Dados do aluno | ❌ Não aplicável | ✅ Consulta individual |

O agente usa **ambas as fontes**: primeiro consulta os arquivos de conhecimento
(resposta rápida), e pode complementar com a API do EVO quando necessário
(dados dinâmicos como vagas, dados de aluno, etc.).

## Arquivos disponíveis

- `planos-e-valores.md` — Modalidades, tabela de preços, descontos
- `grade-horaria.md` — Horários de funcionamento e grade de aulas
- `informacoes-gerais.md` — Sobre, diferenciais, FAQ, regras do bot
