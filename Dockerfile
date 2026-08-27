# syntax=docker/dockerfile:1.7

# SmartLearning backend — production image (compiled CJS runtime).
#
# Prisma 7.9.1 compatibility note:
#   `prisma-client` generates TypeScript source with explicit `.ts` import
#   extensions and an `import.meta.url`-based `__dirname` shim (ESM-style).
#   When `tsc` (module: commonjs) compiles that, the emitted `require()` keeps
#   the `.ts` suffix but only `.js` files land in dist/ → "Cannot find module".
#   So after `prisma generate` we normalize the generated source to CJS-safe
#   TypeScript (strip `.ts` import extensions, drop the `import.meta` shim).
#   This makes `nest build` → `node dist/src/main` run on plain Node, matching
#   the working dev path.
#
# Stages:
#   1. builder  — npm ci, prisma generate, patch generated source, nest build.
#   2. migrate  — Prisma CLI + schema + migrations (one-shot `migrate deploy`).
#   3. runtime  — prod deps + dist + generated client. Runs `node dist/src/main`.
#
# argon2 native addon: build toolchain stays in builder; runtime gets the
# prebuilt binary from the builder's node_modules via `npm prune --omit=dev`.

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma.config.ts ./prisma.config.ts
RUN npm ci --include=dev

# Generate the Prisma client (TypeScript source at /app/generated/prisma).
COPY prisma ./prisma
RUN npx prisma generate

# Normalize the generated client to CJS-safe TS so `tsc` (module: commonjs)
# emits require() calls that actually resolve in dist/:
#   1. Drop the `import { fileURLToPath } from 'node:url'` line.
#   2. Drop the `globalThis['__dirname'] = ... import.meta.url ...` line
#      (CJS provides a real __dirname).
#   3. Strip `.ts` extensions from relative import/export specifiers.
COPY scripts/normalize-prisma-client.mjs ./scripts/normalize-prisma-client.mjs
RUN node scripts/normalize-prisma-client.mjs generated/prisma \
    && echo "=== patched client.ts head ===" \
    && sed -n '14,24p' generated/prisma/client.ts

# Compile. nest build emits dist/src/main.js (tsconfig rootDir=src preserved).
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prod-only deps (drops dev tooling; keeps native argon2 binary).
RUN npm prune --omit=dev

# --- migrate stage -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS migrate

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/prisma ./prisma

ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

# --- runtime stage -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system nodejs && useradd --system --gid nodejs nodejs

COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# nest build emits dist/src/main.js (tsconfig rootDir=src → preserved under outDir).
CMD ["node", "dist/src/main"]