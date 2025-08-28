# =============================================================================
# TERRASTORIES API DOCKERFILE
# Multi-stage production-optimized build
# =============================================================================

# Development stage - includes dev dependencies and debugging tools
FROM node:20.18.0-alpine AS development

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
FROM node:20.18.0-alpine AS builder

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

# Remove dev dependencies
RUN npm ci --omit=dev && npm cache clean --force

# =============================================================================
# Production runtime - minimal footprint
FROM node:20.18.0-alpine AS production

# Install system dependencies for runtime
RUN apk add --no-cache \
    sqlite \
    dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S terrastories -u 1001

# Create app directory
WORKDIR /app

# Create uploads directory with proper permissions
RUN mkdir -p uploads && chown -R terrastories:nodejs uploads

# Copy built application from builder stage
COPY --from=builder --chown=terrastories:nodejs /app/dist ./dist
COPY --from=builder --chown=terrastories:nodejs /app/node_modules ./node_modules
COPY --chown=terrastories:nodejs package*.json ./

# Create data directory for SQLite (if needed)
RUN mkdir -p data && chown -R terrastories:nodejs data

# Switch to non-root user
USER terrastories

# Expose API port
EXPOSE 3000

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start production server
CMD ["npm", "start"]