# syntax=docker/dockerfile:1

# The build output is architecture-independent JavaScript. Running this stage on
# the native builder avoids QEMU crashes while producing multi-platform images.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache docker-cli docker-cli-compose tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STATIC_ROOT=/app/dist/client \
    COMPOSE_ROOT=/composeFile \
    DOCKER_SOCKET=/var/run/docker.sock \
    MIRROR_STORE_PATH=/data/registry-mirrors.json \
    HOST_DOCKER_CONFIG_PATH=/etc/docker/daemon.json
COPY --from=build /app/dist ./dist
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.cjs"]
