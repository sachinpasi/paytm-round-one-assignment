FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# deps first so this layer is cached when only the source changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY src ./src

USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "src/server.js"]
