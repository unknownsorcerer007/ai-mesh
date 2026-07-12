FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app

# Install dependencies (multi-arch compatible)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl sqlite3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Download NATS server binary (auto-detect architecture)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then NATS_ARCH="arm64"; else NATS_ARCH="amd64"; fi && \
    curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v2.10.22/nats-server-v2.10.22-linux-${NATS_ARCH}.tar.gz" -o /tmp/nats.tar.gz && \
    tar xzf /tmp/nats.tar.gz -C /tmp && \
    mv /tmp/nats-server-v2.10.22-linux-${NATS_ARCH}/nats-server /usr/local/bin/ && \
    rm -rf /tmp/nats* && \
    chmod +x /usr/local/bin/nats-server

# Copy app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY public/ public/
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
