FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app

# Install NATS server + curl
RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 && rm -rf /var/lib/apt/lists/*

# Download NATS server
RUN curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh && mv nats-server /usr/local/bin/

# Copy app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY start-prod.sh /app/start-prod.sh
RUN chmod +x /app/start-prod.sh

RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=3737
ENV HOST=0.0.0.0
ENV NATS_URL=nats://localhost:4222
ENV DB_PATH=/app/data/ai-mesh.db

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3737/health || exit 1

CMD ["/app/start-prod.sh"]
