SHELL := /bin/bash

.PHONY: help deps dev-backend dev-web run-backend run-web build-backend build-web build test docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make deps          - install backend/web dependencies"
	@echo "  make dev-backend   - run Go backend in dev mode"
	@echo "  make dev-web       - run React frontend dev server"
	@echo "  make run-backend   - run backend serving built frontend assets"
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

