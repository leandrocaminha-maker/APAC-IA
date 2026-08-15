FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/

EXPOSE 3100

CMD ["node", "src/server.js"]
