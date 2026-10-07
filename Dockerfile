# Chip Wars — production image
# Single container serves both the static frontend (index.html/ui.js/
# net.js/renderer.js/engine.js/styles.css) and the Socket.IO backend —
# there's nothing to build/bundle, so this is a plain runtime image.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json
# actually changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Matches the /healthz route added in server.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
