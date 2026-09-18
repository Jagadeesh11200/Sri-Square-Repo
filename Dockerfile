# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3030 \
    DB_PATH=/app/data/sri-square.db
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY icon-192.png icon-512.png ./

RUN mkdir -p /app/data/backups && chown -R node:node /app
USER node

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3030/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
