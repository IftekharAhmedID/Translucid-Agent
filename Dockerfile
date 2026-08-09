FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/investigator
COPY package.json package-lock.json ./
RUN npm ci

COPY Dockerfile ./
COPY scripts/runtime-manifest.ts scripts/runtime-manifest.ts
COPY src/core/input.ts src/core/input.ts
COPY runtime runtime
RUN chmod 0555 runtime/start.sh \
  && mkdir -p /workspace/case \
  && chown -R node:node /workspace /opt/investigator

USER node
EXPOSE 4096
