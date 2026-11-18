FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
# mediasoup 的 postinstall 需要 python3 + pip（invoke），预编译 worker 跑不起来时回退本地编译
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-setuptools python3-wheel \
    build-essential python3-dev pkg-config \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=192
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY dist ./dist
RUN mkdir /data && chown node:node /data
USER node
ENV DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=4s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
