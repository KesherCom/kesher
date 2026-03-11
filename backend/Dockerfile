FROM node:22-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM golang:1.23-alpine AS go-build
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG BUILD_TIMESTAMP=unknown
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend/ .
COPY --from=web-build /src/web/dist ./internal/app/embedded_web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X github.com/KesherCom/kesher/backend/internal/app.Version=$VERSION -X github.com/KesherCom/kesher/backend/internal/app.BuildTimestamp=$BUILD_TIMESTAMP" -o /out/server ./cmd/server

FROM alpine:3.21
LABEL org.opencontainers.image.title="kesher"
LABEL org.opencontainers.image.description="On-prem web-based intercom for church live productions"
LABEL org.opencontainers.image.source="https://github.com/KesherCom/kesher"
WORKDIR /app
COPY --from=go-build /out/server /app/server
RUN mkdir -p /app/data
EXPOSE 8080
ENV APP_ADDR=:8080
ENV DB_PATH=/app/data/intercom.db
ENV ALLOW_CORS=false
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz >/dev/null 2>&1 || exit 1
CMD ["/app/server"]
