# Build stage, pinned to the BUILD platform so Node never runs under arm64
# emulation (see the service Dockerfiles for the crash this avoids).
#
# This stage deliberately does NOT cross-install: vite's esbuild and rollup
# dependencies are native binaries that must match the machine running the
# build, so `npm install` here is correct and `--cpu=$TARGETARCH` would install
# binaries the builder cannot execute. The build output is static HTML, CSS and
# JS with no architecture-specific content, which is what makes this safe.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built files to nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx configuration (optional)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
