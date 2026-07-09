FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
RUN mkdir -p data
ENV NODE_ENV=production
ENV PORT=3737
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/ai-mesh.db
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3737/health || exit 1
CMD ["node", "dist/index.js"]
