# Stage 1: Build the application
FROM registry.access.redhat.com/hi/nodejs:22-builder AS builder

USER 0
WORKDIR /pdf-gen
COPY . .
RUN mkdir -p bin

# Install build tools for native npm modules (node-gyp)
RUN dnf install -y python3 make gcc-c++ git && dnf clean all

# Install npm dependencies from lockfile (skip default Chrome download)
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Download Chrome 149.0.7827.103 for PDF generation (patches CVEs in bundled 149.0.7827.22)
RUN npx @puppeteer/browsers install chrome@149.0.7827.103 --path /opt/app-root/src/.cache/puppeteer

# Check for circular dependencies
RUN node circular.js

# Build the application
ENV NODE_ENV=production
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Collect Chrome runtime dependencies
# UBI9 base is used here because the hardened builder image lacks the full
# set of X11/GTK repos needed for Chrome dependencies. This stage is
# intermediate and discarded after build.
FROM registry.access.redhat.com/ubi9/ubi:latest AS chrome-deps

# Snapshot installed packages before adding Chrome deps
RUN rpm -qa --queryformat '%{NAME}\n' | sort > /pkgs-before.txt

# Install Chrome runtime dependencies
RUN dnf install -y bzip2 fontconfig pango \
  libXcomposite libXcursor libXdamage \
  libXext libXi libXtst cups-libs \
  libXScrnSaver libXrandr alsa-lib \
  atk gtk3 libdrm libgbm libxshmfence \
  nss && dnf clean all

# Collect only files from newly installed packages into /chrome-rootfs
# This avoids copying unrelated packages to the runtime image.
# Directories are created (not copied) to prevent recursive copies of
# shared system directories like /usr/lib64.
RUN rpm -qa --queryformat '%{NAME}\n' | sort > /pkgs-after.txt && \
    comm -13 /pkgs-before.txt /pkgs-after.txt > /new-pkgs.txt && \
    mkdir -p /chrome-rootfs && \
    cat /new-pkgs.txt | xargs rpm -ql 2>/dev/null | while IFS= read -r f; do \
      if [ -d "$f" ] && [ ! -L "$f" ]; then \
        mkdir -p "/chrome-rootfs$f"; \
      elif [ -e "$f" ] || [ -L "$f" ]; then \
        mkdir -p "/chrome-rootfs$(dirname "$f")" && \
        cp -a "$f" "/chrome-rootfs$f" 2>/dev/null || true; \
      fi; \
    done

# Stage 3: Runtime (hardened distroless image)
FROM registry.access.redhat.com/hi/nodejs:22

WORKDIR /pdf-gen

# Copy Chrome runtime dependencies (libs, fonts, configs) from chrome-deps stage
COPY --from=chrome-deps /chrome-rootfs/ /

# Copy application artifacts from builder
COPY --chown=1001:0 --from=builder /pdf-gen/dist ./dist
COPY --chown=1001:0 --from=builder /pdf-gen/node_modules ./node_modules
COPY --chown=1001:0 --from=builder /pdf-gen/package.json ./package.json
COPY --chown=1001:0 --from=builder /pdf-gen/public ./public
COPY --chown=1001:0 --from=builder /pdf-gen/docs/openapi.json ./docs/openapi.json

# Copy Chrome binary
COPY --chown=1001:0 --from=builder /opt/app-root/src/.cache/puppeteer /opt/app-root/src/.cache/puppeteer

ENV HOME=/opt/app-root/src
ENV XDG_CONFIG_HOME="/tmp/.chromium"
ENV XDG_CACHE_HOME="/tmp/.chromium"
ENV NODE_ENV=production
ENV DEBUG=puppeteer-cluster:*

EXPOSE 8000
CMD ["node", "./dist/server.js"]
