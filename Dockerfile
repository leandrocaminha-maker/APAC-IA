FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/

# As ferramentas de operação também vão para a imagem.
#
# Sem isto, `docker compose exec backend npm run campanha` falha com
# MODULE_NOT_FOUND — a imagem tinha só `src/`. Passou despercebido porque os
# scripts antigos (prompt, grade, conversas, consultor) sempre foram rodados
# da máquina do desenvolvedor, que alcança Supabase e EVO pela rede.
#
# A campanha é outro caso: quem conduz o piloto precisa ver e parar o
# disparo de onde ele acontece, sem depender de ter o repositório clonado.
COPY scripts/ ./scripts/

EXPOSE 3100

CMD ["node", "src/server.js"]
