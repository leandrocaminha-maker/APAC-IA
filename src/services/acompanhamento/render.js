/**
 * src/services/acompanhamento/render.js
 * O preenchimento dos marcadores de uma mensagem do acompanhamento.
 *
 * PURO: nada de banco, rede ou relógio do sistema — quem chama passa o
 * dia. É o que deixa os testes (`render.test.js`) rodarem sem `.env`.
 *
 * ## Falha fechada
 *
 * Marcador sem valor tira o modelo da vez: `preencher` devolve `texto:
 * null` e a lista do que faltou, e a régua passa ao modelo seguinte.
 * Nunca sai `{chave}` crua nem frase com buraco — "Faz  dias" é pior do
 * que mensagem nenhuma, porque o aluno lê e conclui que é robô.
 *
 * ## De onde vem cada valor
 *
 * O Prescrev diz, na lista de marcadores que publica com os modelos, a
 * fonte de cada um:
 *
 *   ficha  vem pronto em `ficha.marcadores` — exceto {dias_avaliacao}, que
 *          muda todo dia e se conta aqui de `ficha.proxima_avaliacao`
 *   evo    o APAC preenche com o que lê do EVO, na régua: {dias} do aviso
 *          "Sem presença"; {dia_retorno}, {atividade_retorno} e {modalidade}
 *          da agenda; {treinos_ciclo} e {minimo_ciclo} do treino; e
 *          {professor}, do treino, quando o card não escolheu ninguém (D3)
 */

/**
 * O primeiro nome como se escreve numa mensagem — a mesma regra do Prescrev
 * (`primeiroNome` em acompanhamento/ficha.ts): "VANESSA ROBERT" vira "Vanessa".
 * Para o nome do professor que vem do EVO, que chega como foi cadastrado.
 */
export function primeiroNome(nome) {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (!p) return '';
  if (p !== p.toUpperCase() && p !== p.toLowerCase()) return p;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** Dias de `de` até `ate`, as duas datas 'AAAA-MM-DD'. Negativo se `ate` já passou. */
export function diasEntre(de, ate) {
  const [a, b] = [de, ate].map(d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Os valores dos marcadores para uma ficha, no dia `hoje`.
 *
 * {dias_avaliacao} só tem valor de 2 dias para cima: "faltam 1 dias" e
 * "faltam 0 dias" não são frase, e nessa semana quem fala da reavaliação
 * é a mensagem de reavaliação.
 *
 * {proxima_avaliacao} perde o valor quando a data passa. A ficha a traz
 * pronta ("21/11") e só muda quando o Prescrev grava a avaliação seguinte;
 * sem isto, "sua reavaliação é em 21/11" sairia em 28/11 — foi o que a
 * primeira simulação mostrou.
 */
export function valoresDaFicha(ficha, hoje) {
  const valores = { ...(ficha.marcadores ?? {}) };
  const ate = ficha.proxima_avaliacao ? diasEntre(hoje, ficha.proxima_avaliacao) : null;
  valores.dias_avaliacao = ate !== null && ate >= 2 ? String(ate) : null;
  if (ate === null || ate < 0) valores.proxima_avaliacao = null;
  return valores;
}

/**
 * Preenche os marcadores de um texto.
 * @returns {{ texto: string|null, faltam: string[] }}
 */
export function preencher(texto, valores) {
  const faltam = [];
  const saida = texto.replace(/\{([a-z_]+)\}/g, (inteiro, chave) => {
    const v = valores[chave];
    if (v === null || v === undefined || String(v).trim() === '') {
      faltam.push(chave);
      return inteiro;
    }
    return String(v);
  });
  return faltam.length ? { texto: null, faltam: [...new Set(faltam)] } : { texto: saida, faltam: [] };
}
