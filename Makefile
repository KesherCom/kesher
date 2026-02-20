SHELL := /bin/bash
LAN_IP ?= 127.0.0.1

.PHONY: help deps dev-backend dev-web run-backend run-backend-https run-web build-backend build-web build test docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make deps          - install backend/web dependencies"
	@echo "  make dev-backend   - run Go backend in dev mode"
	@echo "  make dev-web       - run React frontend dev server"
	@echo "  make run-backend   - run backend serving built frontend assets"
	@echo "  make run-backend-https - run backend with HTTPS; auto-generate self-signed certs if missing (LAN_IP=... optional)"
	@echo "  make run-web       - alias for dev-web"
	@echo "  make build-backend - build backend binary"
	@echo "  make build-web     - build frontend bundle"
	@echo "  make build         - build backend + frontend"
	@echo "  make test          - run backend tests + frontend build"
	@echo "  make docker-build  - build Docker image via compose"
	@echo "  make docker-up     - run app via Docker compose"
	@echo "  make docker-down   - stop Docker compose app"
	@echo "  make clean         - remove common build artifacts"

deps:
	@cd backend && go mod tidy
	@cd web && npm install

dev-backend:
	@cd backend && go run ./cmd/server

dev-web:
	@cd web && npm run dev

run-web: dev-web

run-backend: build-web
	@cd backend && STATIC_DIR=../web/dist go run ./cmd/server
run-backend-https: build-web
	@mkdir -p backend/certs
	@if [[ ! -f backend/certs/lan-cert.pem || ! -f backend/certs/lan-key.pem ]]; then \
		echo "Generating self-signed certs for LAN_IP=$(LAN_IP)"; \
		openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
			-keyout backend/certs/lan-key.pem \
			-out backend/certs/lan-cert.pem \
			-subj "/CN=$(LAN_IP)" \
			-addext "subjectAltName=IP:$(LAN_IP),DNS:localhost"; \
	fi
	@cd backend && STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false TLS_CERT_FILE=./certs/lan-cert.pem TLS_KEY_FILE=./certs/lan-key.pem go run ./cmd/server

build-backend:
	@mkdir -p backend/bin
	@cd backend && go build -o ./bin/server ./cmd/server

build-web:
	@cd web && npm run build

build: build-backend build-web

test:
	@cd backend && go test ./...
	@cd web && npm run build

docker-build:
	@docker compose -f deploy/compose/docker-compose.yml build

docker-up:
	@docker compose -f deploy/compose/docker-compose.yml up --build

docker-down:
	@docker compose -f deploy/compose/docker-compose.yml down

clean:
	@rm -rf backend/bin
	@rm -rf web/dist

