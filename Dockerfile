# Self-hosted Spend Wise server. Electron is a devDependency and never
# installed here — the runtime is plain Node + lowdb.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src

ENV FINANCES_DB_PATH=/data/db.json \
    FINANCES_PORT=4180 \
    FINANCES_HOST=0.0.0.0

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 4180
USER node

# The login page answers 200 once a password is set, 503 before that — both
# mean the process is alive and serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:${FINANCES_PORT}/ || exit 1

CMD ["node", "src/server/cli.mjs"]
