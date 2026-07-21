# Stage 1: Build
FROM registry.access.redhat.com/ubi9/nodejs-22:1-1784594179@sha256:03972e440fc806d71a87982d7044616aa185b7bbe6c821642e9510c418e21a40 AS builder

USER 0
WORKDIR /pdf-gen

# Install build tools for native npm modules (node-gyp)
RUN mkdir -p bin \
 && dnf install -y python3 make gcc-c++ git \
 && dnf clean all

# Install npm dependencies from lockfile — separate layer so code changes don't bust npm cache
COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Copy source after dependency install
COPY . .

# Download pinned Chrome, validate build, produce production bundle
ENV NODE_ENV=production
RUN npx @puppeteer/browsers install chrome@150.0.7871.125 --path /opt/app-root/src/.cache/puppeteer \
 && node circular.js \
 && npm run build \
 && npm prune --omit=dev

# Stage 2: Runtime
FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:1-1784124526@sha256:e821984ab8265a8b8f46b01e9595a7633decc75813d34a9dce99cc42430af6ec

USER 0
WORKDIR /pdf-gen

# Install Chrome runtime dependencies
RUN microdnf install -y bzip2 fontconfig pango \
  libXcomposite libXcursor libXdamage \
  libXext libXi libXtst cups-libs \
  libXScrnSaver libXrandr alsa-lib \
  atk gtk3 libdrm libgbm libxshmfence \
  nss && microdnf clean all

# Copy application artifacts from builder
COPY --from=builder /pdf-gen/dist ./dist
COPY --from=builder /pdf-gen/node_modules ./node_modules
COPY --from=builder /pdf-gen/package.json ./package.json
COPY --from=builder /pdf-gen/public ./public
COPY --from=builder /pdf-gen/docs/openapi.json ./docs/openapi.json

# Copy Chrome binary
COPY --from=builder /opt/app-root/src/.cache/puppeteer /opt/app-root/src/.cache/puppeteer

USER 1001

ENV HOME=/opt/app-root/src
ENV XDG_CONFIG_HOME="/tmp/.chromium"
ENV XDG_CACHE_HOME="/tmp/.chromium"
ENV NODE_ENV=production
ENV DEBUG=puppeteer-cluster:*

EXPOSE 8000
CMD ["node", "./dist/server.js"]
