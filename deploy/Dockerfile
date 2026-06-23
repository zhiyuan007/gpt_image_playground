# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__
ENV VITE_API_PROXY_LOCKED=__VITE_API_PROXY_LOCKED_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__
ENV VITE_DOCKER_LEGACY_API_URL_USED=__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__
ENV VITE_SHOW_DEFAULT_CONFIG_ONLY=__VITE_SHOW_DEFAULT_CONFIG_ONLY_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

RUN apk add --no-cache nodejs

ENV HOST=0.0.0.0
ENV PORT=80
ENV DEFAULT_API_URL=
ENV API_PROXY_URL=
ENV ENABLE_API_PROXY=false
ENV LOCK_API_PROXY=false
ENV SHOW_DEFAULT_CONFIG_ONLY=false
ENV JOB_SERVER_HOST=127.0.0.1
ENV JOB_SERVER_PORT=3001
ENV JOB_ACCESS_PASSWORD=
ENV JOB_AUTH_SECRET=
ENV JOB_AUTH_TTL_HOURS=168
ENV JOB_RESULT_TTL_HOURS=24
ENV JOB_CONCURRENCY=1
ENV JOB_MAX_PENDING=10
ENV JOB_MAX_STORAGE_BYTES=1073741824
ENV JOB_RESULT_RATE_LIMIT_BYTES_PER_SECOND=384000
ENV JOB_ALLOWED_BASE_URLS=https://api.ciyuanshen.top/v1,https://ciyuanshen.top/v1
ENV JOB_DATA_DIR=/tmp/gpt-image-playground-jobs

COPY --from=build /app/dist /usr/share/nginx/html
COPY server /app/server
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/migrate-api-env.envsh /docker-entrypoint.d/05-migrate-api-env.envsh
COPY --chmod=755 deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
