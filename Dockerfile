# =============================================================================
# TERRASTORIES API DOCKERFILE
# Multi-stage production-optimized build
# =============================================================================

# Development stage - includes dev dependencies and debugging tools
FROM node:26.13.1-alpine AS development

# Install system dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies)
RUN npm ci

# Copy source code
COPY . .

# Expose API port and debug port
EXPOSE 3000 9229

# Start development server with hot reload
CMD ["npm", "run", "dev"]

# =============================================================================
# Production build stage - compiles TypeScript
FROM node:26.13.1-alpine AS builder

# Install system dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies from the locked install without rerunning lifecycle scripts.
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

# =============================================================================
# Production runtime - minimal footprint
FROM node:26.13.1-alpine AS production

ENV NODE_ENV=production

# Patch the supported Alpine runtime and install only required system packages.
RUN apk upgrade --no-cache && \
    apk add --no-cache \
      sqlite \
      dumb-init && \
    rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 && \
    rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S terrastories -u 1001

# Create app directory
WORKDIR /app

# V2 (Hono) runtime defaults. The listener binds all interfaces inside the container;
# publish it only behind the reverse proxy or on a trusted network.
ENV HONO_HOST=0.0.0.0 \
    HONO_PORT=3001 \
    HONO_STORAGE_ROOT=/app/uploads

# Create uploads directory with proper permissions
RUN mkdir -p uploads erasure-records && chown -R terrastories:nodejs uploads erasure-records && chmod 700 erasure-records

# Copy built application and runtime migration assets from builder stage
COPY --from=builder --chown=terrastories:nodejs /app/dist ./dist
COPY --from=builder --chown=terrastories:nodejs /app/src/db/migrations ./dist/db/migrations
COPY --from=builder --chown=terrastories:nodejs /app/node_modules ./node_modules
COPY --chown=terrastories:nodejs package*.json ./

# Create data directory for SQLite (if needed)
RUN mkdir -p data && chown -R terrastories:nodejs data

# Switch to non-root user
USER terrastories

# Expose V2 (Hono) API port
EXPOSE 3001

# Add health check (V2 /health answers {"status":"ok"})
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Apply the dialect-matched migrations, then start the V2 Hono server. The legacy
# Fastify entrypoint (dist/server.js) is no longer the production command; it
# remains in the image only for the development target and legacy test jobs.
# Package managers are not present at runtime.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/hono-server.js"]
