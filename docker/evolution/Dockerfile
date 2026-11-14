# Evolution API 2.3.7 (Baileys 7.0.0-rc.9) com a stanza <status> confirmada.
#
# A base é a MESMA imagem que rodava na VPS desde 19/10/2026, fixada pelo
# digest. Era `evoapicloud/evolution-api:latest`, e o `latest` já andou para
# outra versão: um `docker compose pull` trocaria a Evolution sem ninguém
# decidir. Para atualizar, troque o digest aqui e rode o build: o patch confere
# a versão do Baileys e derruba o build se ela mudou.
#
# Por que o patch: ver patch-status-ack.cjs (queda a cada 50 min, 11/2026).
FROM evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252

COPY patch-status-ack.cjs /tmp/patch-status-ack.cjs
RUN node /tmp/patch-status-ack.cjs /evolution/node_modules/baileys \
 && rm /tmp/patch-status-ack.cjs
