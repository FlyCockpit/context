FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base

# PGDG supplies the matching PostgreSQL 18 clients; Debian trixie supplies
# git >=2.37, SSH, ripgrep and tini. Upgrade base OS packages on cache refresh.
ARG APT_CACHE_DATE=static
ARG PG_MAJOR=18
RUN echo "apt-cache-date: ${APT_CACHE_DATE}" \
  && apt-get update -y && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && . /etc/os-release \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y "${VERSION_CODENAME:-}" \
  && apt-get install -y \
  git \
  openssh-client \
  openssl \
  postgresql-client-${PG_MAJOR} \
  ripgrep \
  tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/private/ssl-cert-snakeoil.pem

# --- Landlock helper (the language-server sandbox) ---
# tools/landlock/cockpit-context-landlock.c (libc only) runs each language server inside
# a Landlock ruleset: it reads only its own files, /usr and the one checkout,
# writes only a private temp dir, opens no TCP connection (Landlock ABI 4+),
# and gets an explicit env (packages/explore/src/lsp/sandbox.ts,
# docs/deploy.md § Language-server sandbox). Built FROM base so it links
# against exactly the runtime's glibc; gcc and libc6-dev stay in this stage,
# and only the binary reaches the runner. The shared build script owns the
# hardened compiler flags used here and in local development.
FROM base AS landlock-build
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/build-landlock-helper.mjs scripts/
COPY tools/landlock/cockpit-context-landlock.c tools/landlock/
RUN node scripts/build-landlock-helper.mjs --cc gcc --out /out/cockpit-context-landlock

# --- Build-time base ---
# Adds pnpm (git already comes from the runtime base). Not inherited by the
# final runtime image.
FROM base AS build-base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Install only the SHA-512 pinned packageManager tarball; Node 26 has no Corepack.
COPY package.json scripts/install-pnpm.mjs /tmp/pnpm-bootstrap/
RUN node /tmp/pnpm-bootstrap/install-pnpm.mjs /tmp/pnpm-bootstrap/package.json && rm -rf /tmp/pnpm-bootstrap

# --- Builder stage ---
# pnpm install runs here with source files present so workspace symlinks resolve correctly
FROM build-base AS builder

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/explore/package.json packages/explore/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/jobs/package.json packages/jobs/
COPY packages/repos/package.json packages/repos/
COPY packages/runs/package.json packages/runs/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config must be present before install (postinstall runs prisma generate)
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Strip the root `postinstall` (which only runs `lefthook install`, a dev-only
# git hook installer that errors without a real repo). The real package.json is
# restored by the subsequent `COPY . .`, so this only affects the install step.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# Resolve the build targets and root tooling against the frozen lockfile.
RUN pnpm install --frozen-lockfile --filter=server... --filter=web... --include-workspace-root

COPY . .

# Keep the restored root package.json from reintroducing the dev-only lefthook
# installer in later Docker build steps after the full source tree is copied.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# Remove any stale .js files next to .tsx route files (breaks TanStack Router)
RUN find apps/web/src/routes -name '*.js' -delete 2>/dev/null || true

# Build-time client env. Vite inlines VITE_* into the SPA bundle during the
# build below — they are NOT read at runtime, so they must be present here.
# Platforms that forward env vars into the Docker build inject them as build
# args with matching keys. Both are
# optional; an empty value falls back to the app default (VITE_APP_NAME -> "App",
# VITE_SERVER_URL -> window.location.origin). Changing either requires a REBUILD,
# not just a restart.
ARG VITE_APP_NAME=""
ARG VITE_SERVER_URL=""
ENV VITE_APP_NAME=$VITE_APP_NAME \
    VITE_SERVER_URL=$VITE_SERVER_URL

# Deterministic build version. The web build (vite.config.ts → getBuildVersion())
# prefers process.env.BUILD_VERSION over `git rev-parse` — and `.git` is excluded
# from the Docker context, so without this the build falls back to a random UUID
# per build (a fresh "version" on every rebuild of the SAME commit). Pass a
# stable value (the git SHA) so identical content keeps the same version across
# rebuilds. Empty = falls back to the random UUID. Pass it as a build arg
# (wired to the commit SHA) to make it stable.
ARG BUILD_VERSION=""
ENV BUILD_VERSION=$BUILD_VERSION

# --- Turborepo Remote Cache (docs/development.md) ---
# Shipped present-but-inert: with both empty (the default on a fresh clone),
# turbo reports NotLinked and the build runs normally with local cache only —
# no error, no behavior change ("just skips"). Set TURBO_TOKEN + TURBO_TEAM
# (BOTH required; a token alone is ignored) to make `turbo build` replay cached
# app outputs from Vercel's free remote cache ("just works"). Platforms that
# forward env vars into the Docker build as build args
# populate these automatically; everywhere else pass them explicitly, e.g.
# `docker build --build-arg TURBO_TOKEN=… --build-arg TURBO_TEAM=…`. Self-host
# instead? add a matching `ARG TURBO_API=""` here and point it at your cache
# (see the pattern doc). Builder stage ONLY — the final runner stage is
# FROM base and never inherits these ENVs, so the token never ships in the
# image.
ARG TURBO_TOKEN=""
ARG TURBO_TEAM=""
ENV TURBO_TOKEN=$TURBO_TOKEN \
    TURBO_TEAM=$TURBO_TEAM

# Give the Vite/rolldown + turbo build heap headroom. Builder stage ONLY — the
# runner stage is FROM base and sets its own (much lower) runtime default below.
ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN pnpm turbo build --filter=server --filter=web
RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT

# Verify build outputs exist
RUN test -f apps/server/dist/index.mjs && test -d apps/web/dist/client && test -d apps/web/dist/server

# --- Production deps stage ---
FROM build-base AS prod-deps

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/explore/package.json packages/explore/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/jobs/package.json packages/jobs/
COPY packages/repos/package.json packages/repos/
COPY packages/runs/package.json packages/runs/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config needed for postinstall
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Install prod deps for BOTH the server and the web app. The server bundle
# imports the built web SSR handler (apps/web/dist/server), which leaves `react`
# external — so web's runtime deps must be present in the image for SSR to load.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter=server... --filter=web... --include-workspace-root

# The TypeScript compiler STAYS in the prod tree: TypeScript 7's native binary
# (`@typescript/typescript-linux-<arch>/lib/tsc`, spawned as `tsc --lsp
# --stdio`) is Cockpit Context's TypeScript/JavaScript language server, and `pyright` is
# the Python one. apps/server declares both as runtime dependencies so the
# bundled server (apps/server/dist/index.mjs) resolves them; the runner stage
# proves that at build time. The template stripped TypeScript here to keep its
# Go stdlib out of Trivy's view; Cockpit Context accepts that surface (docs/hosting.md).

# --- Runner: the single app, migrations and backup image ---
FROM base AS runner

ARG IMAGE_VERSION=dev
ARG VCS_REF=""
LABEL org.opencontainers.image.title="Cockpit Context" \
      org.opencontainers.image.source="https://github.com/FlyCockpit/context" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="FlyCockpit LLC" \
      org.opencontainers.image.url="https://github.com/FlyCockpit/context" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production
ENV SERVER_PORT=3000
# Default Node heap cap so the server behaves predictably on small hosts.
# Deploy-time env always wins (`docker run -e NODE_OPTIONS=…` / the
# orchestrator's env panel). SSR + Prisma + request handling live on the V8
# heap, so 512 MB is the safe floor for the server. Size the container's memory
# LIMIT ~25–50% above this cap to leave room for native (off-heap) memory.
#
# Do not lower this from plan arithmetic alone. The tempting argument is a
# small plan with a 512 MB TOTAL memory limit, where a 512 MB heap cap lets
# V8 grow to the whole container before collecting hard and
# native allocations then push RSS into a platform OOM-kill instead of
# V8 back-pressure. True as far as it goes — but a lower cap does not lower
# actual demand. If SSR + Prisma + request handling genuinely need more than the
# lower number under load, the trade is a guaranteed heap OOM for a possible one.
# Measure the heap high-water mark under real SSR traffic first; if it does not
# sit comfortably under the proposed cap, the answer is a larger plan.
ENV NODE_OPTIONS="--max-old-space-size=512"
WORKDIR /app
COPY LICENSE THIRD-PARTY-LICENSES.md ./

# Copy workspace config (needed for pnpm --filter at runtime)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/

# Copy production node_modules. The two Prisma-bearing trees are
# --chown=node:node: Prisma migrations run at runtime as USER node and
# materializes its schema engine into node_modules, so uid 1000 must own
# them. Done at COPY time (not a RUN chown) to avoid duplicating the layer.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=node:node --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
# web's node_modules: the server bundle dynamically imports apps/web/dist/server,
# whose SSR chunks resolve `react` (left external by the web build) from here.
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules

# Copy Prisma schema + config for runtime Prisma migrations (gated on MIGRATE_ON_START)
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/prisma.config.ts ./packages/db/prisma.config.ts
# Copy generated Prisma client (built during deps stage)
COPY --from=builder /app/packages/db/prisma/generated ./packages/db/prisma/generated
# packages/db declares prisma, pg and dotenv as production dependencies.
# Its copied pnpm links resolve against the root production store above.
# Validate the CLI/config as the runtime user without contacting a database.
RUN su node -s /bin/sh -c 'cd packages/db && export CHECKPOINT_DISABLE=1 && \
    node node_modules/prisma/build/index.js --version && \
    node node_modules/prisma/build/index.js validate' >/dev/null

# Copy built server and web SPA
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# The single image supports migration, backup and restore commands.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/db/ ./scripts/db/
COPY scripts/backup/ ./scripts/backup/
COPY scripts/build-commit.mjs scripts/backup-heartbeat.mjs scripts/assert-local-database.sh ./scripts/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh ./scripts/backup/*.sh
RUN mkdir -p /backups && chown node:node /backups && chmod 0700 /backups

# Strip the global npm CLI from the runtime image. The server runs `node`
# directly (CMD) and the entrypoint invokes the COPY'd prisma binary by path
# (not `npx`), so npm is never used at runtime. node:slim's bundled npm
# vendors its own dependency tree (e.g. picomatch) that Trivy flags as
# fixable HIGH CVEs we cannot patch via pnpm overrides — removing npm
# eliminates that whole class, shrinks the image, and cuts attack surface.
# Build stages keep npm; this only affects the final runner image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The Landlock helper, at the fixed path the app looks for
# (LANDLOCK_HELPER_IMAGE_PATH in packages/explore/src/lsp/sandbox.ts):
# root-owned, 0755, never writable by the app user.
COPY --from=landlock-build --chown=root:root --chmod=0755 /out/cockpit-context-landlock /usr/local/libexec/cockpit-context/cockpit-context-landlock

# Prove, as the runtime user, that Cockpit Context's runtime tools are on PATH (git 2.37+,
# ssh, ssh-keygen, ssh-keyscan, rg), that the Landlock helper is installed,
# and that both language servers resolve from the bundled server exactly as
# packages/explore/src/lsp/specs.ts resolves them (createRequire from
# apps/server/dist/index.mjs) and start. A broken prod-deps closure then fails
# the build, not the first investigation. Whether the kernel enforces Landlock
# is only reported here (it depends on the host, not the image); the running
# container decides (docs/deploy.md). The same
# script runs in a live container:
# `docker compose exec app node scripts/check-runtime-tools.mjs --require-sandbox`.
COPY scripts/check-runtime-tools.mjs ./scripts/
RUN su node -s /bin/sh -c 'node scripts/check-runtime-tools.mjs'

# Cockpit Context's data root (COCKPIT_CONTEXT_DATA_DIR, `/data` in production): bare clones,
# checkouts and temporary SSH material. Created and chowned BEFORE VOLUME and
# before dropping privileges so a fresh named volume (compose.yaml's
# cockpit-context-data) inherits node:node instead of being created root-owned
# (docs/deploy.md).
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]

# Drop privileges. The `node` user (uid 1000) ships in the node:26 slim base. The
# server only reads /app at runtime; it writes clones and checkouts to /data,
# the sandbox probe's empty checkout and the entrypoint's mktemp files
# (including pre-migration backup dumps) to /tmp, and
# everything else goes to Postgres over the network. Each language server gets
# a private `cockpit-context-lsp-*` directory under /tmp (its HOME and TMPDIR, the only
# place its Landlock ruleset lets it write), removed when it stops.
USER node

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]

EXPOSE 3000

# compose.yaml (and any orchestrator) reads this healthcheck.
# Use Node's built-in fetch; node:slim does not ship curl or wget.
HEALTHCHECK --interval=10s --timeout=5s --start-period=510s --retries=3 \
  CMD node -e "const port=process.env.SERVER_PORT||process.env.PORT||3000;fetch('http://localhost:'+port+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the server. Migrations (MIGRATE_ON_START) run inside the
# ENTRYPOINT before this CMD executes. See scripts/docker-entrypoint.sh.
CMD ["node", "apps/server/dist/index.mjs"]
