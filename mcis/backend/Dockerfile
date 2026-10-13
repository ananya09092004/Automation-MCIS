# Backend (Node/Express) production image.
#
# Multi-stage so the final image carries only production dependencies,
# not devDependencies or the npm cache. Builds from mcis/backend as the
# Docker build context (see ../../docker-compose.yml).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user rather than the image default root.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 5051

# Matches the real route mounted at server.js:245 -- this is not a
# synthetic/placeholder check, it's the same endpoint the app already
# exposes for operational monitoring (see CUSTOMER_SETUP.md section 4).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 5051) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
