FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY .agents ./.agents
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    PICORER_DATA_DIR=/data \
    PICORER_AGENT_DIR=/app/deploy/agent-config \
    PICORER_PROVIDER=picorer-openai \
    PICORER_MODEL=gpt-4o-mini \
    PICORER_TRANSPORT=non-stream

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/.agents ./.agents
COPY deploy/agent-config ./deploy/agent-config

RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/entrypoints/ldbd-api/main.js"]
