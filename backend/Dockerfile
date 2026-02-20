FROM node:22-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ .
RUN npm run build

FROM golang:1.23-alpine AS go-build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend/ .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM alpine:3.21
WORKDIR /app
COPY --from=go-build /out/server /app/server
COPY --from=web-build /src/web/dist /app/web-dist
EXPOSE 8080
ENV APP_ADDR=:8080
ENV STATIC_DIR=/app/web-dist
ENV DB_PATH=/app/data/intercom.db
ENV ALLOW_CORS=false
CMD ["/app/server"]

