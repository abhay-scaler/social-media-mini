# Dependency installation runs on the BUILD platform, never under QEMU.
#
# Emulated arm64 `npm install` intermittently killed the build with
#   qemu: uncaught target signal 4 (Illegal instruction) - core dumped
# after which BuildKit stopped producing output and the job stalled until its
# timeout. QEMU 10.2.3 did not prevent it, so this removes
# the emulated execution instead of trying to make it reliable.
#
# This is exact rather than approximate for this service: its production
# dependency tree has no install scripts and no platform-gated packages, so
# every resolved package is architecture-independent JavaScript.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
ARG TARGETARCH
# npm's --cpu takes Node process.arch names, so amd64 must be spelled x64.
RUN NPM_CPU="$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH")" && \
    npm ci --omit=dev --os=linux --cpu="$NPM_CPU" --libc=musl

# Runtime stage, on the target platform. It must contain no RUN instruction:
# anything executed here would run under emulation for the arm64 image.
FROM node:22-alpine
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 5000
CMD ["node", "server.js"]
