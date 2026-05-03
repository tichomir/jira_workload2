# ── Stage 1: builder ───────────────────────────────────────────────────────────
# Installs all dependencies (including devDependencies needed for tsc) and
# compiles src/**/*.ts → dist/ via `npm run build`.
#
# Justification:
#   - node:20-alpine: matches @types/node ^20.14.0 (package.json devDependencies)
#   - npm run build: "bash scripts/check-deprecated-endpoint.sh && tsc" (package.json:7)
#   - outDir: ./dist (tsconfig.json compilerOptions.outDir)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY db/ ./db/

RUN npm run build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
# Copies compiled output + production dependencies only. Runs as non-root user.
#
# Justification:
#   - Entry point: "node dist/server.js" (package.json scripts.start)
#   - Port: process.env.PORT ?? '3000' (src/server.ts:49)
#   - Volumes: /data (DATABASE_URL default), /attachments (restore download blobs)
FROM node:20-alpine AS runtime

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy database migrations (loaded at runtime via path.join(__dirname, ...))
COPY db/ ./db/

# Create non-root user and prepare writable data directory
RUN addgroup -S jiraapp && adduser -S jiraapp -G jiraapp \
    && mkdir -p /data /attachments \
    && chown -R jiraapp:jiraapp /app /data /attachments

USER jiraapp

# Port discovered in preflight: process.env.PORT ?? '3000' (src/server.ts:49)
EXPOSE 3000

# Matches package.json scripts.start verbatim
CMD ["node", "dist/server.js"]
