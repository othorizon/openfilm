# Use BuildKit's bundled frontend so building does not pull docker/dockerfile
# from Docker Hub before the mirrored base image can be resolved.
ARG NODE_IMAGE=m.daocloud.io/docker.io/library/node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=${NPM_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_DEFAULT_TO_LATEST=0

# node:slim has no system CA bundle. Bootstrap HTTPS using Node's bundled
# public roots, then install Debian's maintained CA bundle from the mirror.
# Optional build_ca is a combined CA bundle for a managed build proxy only.
RUN --mount=type=secret,id=build_ca,mode=0444 \
    set -eu; \
    mkdir -p /etc/ssl/certs; \
    node -e "require('node:fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('node:tls').rootCertificates.join('\n') + '\n')"; \
    printf 'Types: deb\nURIs: %s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "$DEBIAN_MIRROR" "$DEBIAN_SECURITY_MIRROR" > /etc/apt/sources.list.d/debian.sources; \
    set --; \
    if [ -f /run/secrets/build_ca ]; then \
      set -- -o Acquire::https::CaInfo=/run/secrets/build_ca; \
    fi; \
    apt-get "$@" -o Acquire::Retries=3 update; \
    apt-get "$@" -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/cloud/package.json apps/cloud/package.json
RUN --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    export NODE_USE_ENV_PROXY=1; \
    corepack enable && corepack pnpm install --filter @openfilm/cloud --prod --frozen-lockfile --ignore-scripts

COPY --chown=node:node apps/cloud/src apps/cloud/src
COPY --chown=node:node apps/cloud/migrations apps/cloud/migrations
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/cloud/src/main.ts"]
