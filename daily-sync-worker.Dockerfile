FROM node:22-bookworm AS deps

RUN apt-get update && apt-get install -y openssl

WORKDIR /app

COPY .yarn ./.yarn
COPY yarn.lock package.json .yarnrc.yml tsconfig.json tsconfig.root.json lage.config.js ./
COPY packages/api/package.json packages/api/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/component-library/package.json packages/component-library/package.json
COPY packages/crdt/package.json packages/crdt/package.json
COPY packages/desktop-client/package.json packages/desktop-client/package.json
COPY packages/desktop-electron/package.json packages/desktop-electron/package.json
COPY packages/eslint-plugin-actual/package.json packages/eslint-plugin-actual/package.json
COPY packages/loot-core/package.json packages/loot-core/package.json
COPY packages/plugins-service/package.json packages/plugins-service/package.json
COPY packages/sync-server/package.json packages/sync-server/package.json

RUN yarn install

FROM deps AS builder

WORKDIR /app

COPY packages/ ./packages/
COPY bin/ ./bin/

# lage's task hasher invokes `git ls-tree HEAD` during initialization, so it
# needs a git repo even when individual targets disable caching. .dockerignore
# omits the real .git, so seed a throwaway repo with a single commit here.
RUN git -c init.defaultBranch=master init -q \
    && git -c user.email=build@docker -c user.name=docker-build add -A \
    && git -c user.email=build@docker -c user.name=docker-build commit -qm build

RUN yarn build:cli
RUN yarn workspaces focus @actual-app/cli --production

FROM node:22-bookworm-slim AS prod

RUN apt-get update \
    && apt-get install -y tini \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

ARG USERNAME=actual
ARG USER_UID=1001
ARG USER_GID=$USER_UID
RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && mkdir /data \
    && chown -R ${USERNAME}:${USERNAME} /data

WORKDIR /app
ENV NODE_ENV=production
ENV ACTUAL_DATA_DIR=/data

COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/package.json ./package.json
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/node_modules ./node_modules
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/packages ./packages

USER ${USERNAME}
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "packages/cli/dist/cli.js", "server", "bank-sync-worker"]
