# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/cloud/package.json apps/cloud/package.json
# Optional CA for a managed build proxy; it is never included in the image.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    export NODE_USE_ENV_PROXY=1; \
    corepack enable && corepack pnpm install --filter @openfilm/cloud --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node apps/cloud/src apps/cloud/src
COPY --chown=node:node apps/cloud/migrations apps/cloud/migrations
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/cloud/src/main.ts"]
