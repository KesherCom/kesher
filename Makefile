SHELL := /bin/bash
LAN_IP ?= 127.0.0.1

.PHONY: help deps dev-backend dev-web run-backend run-backend-https run-backend-le run-backend-certmagic run-production-le run-production-certmagic run-web sync-embedded-web build-backend build-web build test loadtest loadtest-20 docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make deps          - install backend/web dependencies"
	@echo "  make dev-backend   - run Go backend in dev mode"
	@echo "  make dev-web       - run React frontend dev server"
	@echo "  make run-backend   - run backend serving built frontend assets"
	@echo "  make run-backend-https - run backend with HTTPS using internal self-signed certificates"
	@echo "  make run-backend-le DOMAIN=... - run backend with HTTPS using Let's Encrypt certs from /etc/letsencrypt/live/\$$DOMAIN/"
	@echo "  make run-backend-certmagic DOMAIN=... DNS_PROVIDER=... - run backend with CertMagic ACME DNS-01 automation"
	@echo "  make run-production-le DOMAIN=... - production mode (HTTPS :443 + HTTP :80 redirect) with Let's Encrypt certs"
	@echo "  make run-production-certmagic DOMAIN=... DNS_PROVIDER=... - production mode with in-app CertMagic DNS-01 automation"
	@echo "  make run-web       - alias for dev-web"
	@echo "  make sync-embedded-web - copy web/dist into backend embedded assets directory"
	@echo "  make build-backend - build backend binary"
	@echo "  make build-web     - build frontend bundle"
	@echo "  make build         - build backend + frontend"
	@echo "  make test          - run backend tests + frontend build"
	@echo "  make loadtest      - run staged backend load test with non-ideal network simulation"
	@echo "  make loadtest-20   - run staged backend load test profile that ramps to 20 clients"
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
	@cd backend && STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false TLS_MODE=internal go run ./cmd/server

run-backend-le: build-web
	@if [[ -z "$(DOMAIN)" ]]; then \
		echo "DOMAIN is required. Example: make run-backend-le DOMAIN=intercom.example.org"; \
		exit 1; \
	fi
	@if ! sudo test -f "/etc/letsencrypt/live/$(DOMAIN)/fullchain.pem" || ! sudo test -f "/etc/letsencrypt/live/$(DOMAIN)/privkey.pem"; then \
		echo "Let's Encrypt cert files not found for DOMAIN=$(DOMAIN)"; \
		echo "Expected:"; \
		echo "  /etc/letsencrypt/live/$(DOMAIN)/fullchain.pem"; \
		echo "  /etc/letsencrypt/live/$(DOMAIN)/privkey.pem"; \
		exit 1; \
	fi
	@TMP_CERT_DIR="/tmp/kesher-certs/$(DOMAIN)"; \
	TMP_CERT_FILE="$$TMP_CERT_DIR/fullchain.pem"; \
	TMP_KEY_FILE="$$TMP_CERT_DIR/privkey.pem"; \
	echo "Copying certs to $$TMP_CERT_DIR via sudo..."; \
	sudo mkdir -p "$$TMP_CERT_DIR"; \
	sudo cp "/etc/letsencrypt/live/$(DOMAIN)/fullchain.pem" "$$TMP_CERT_FILE"; \
	sudo cp "/etc/letsencrypt/live/$(DOMAIN)/privkey.pem" "$$TMP_KEY_FILE"; \
	sudo chown "$$(id -u):$$(id -g)" "$$TMP_CERT_FILE" "$$TMP_KEY_FILE"; \
	chmod 644 "$$TMP_CERT_FILE"; \
	chmod 600 "$$TMP_KEY_FILE"; \
	cd backend && STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false TLS_CERT_FILE="$$TMP_CERT_FILE" TLS_KEY_FILE="$$TMP_KEY_FILE" go run ./cmd/server
run-backend-certmagic: build-web
	@if [[ -z "$(DOMAIN)" ]]; then \
		echo "DOMAIN is required. Example: make run-backend-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare"; \
		exit 1; \
	fi
	@if [[ -z "$(DNS_PROVIDER)" ]]; then \
		echo "DNS_PROVIDER is required. Example values: cloudflare, hetzner, route53"; \
		exit 1; \
	fi
	@cd backend && STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false TLS_MODE=certmagic CERTMAGIC_DOMAINS="$(DOMAIN)" CERTMAGIC_DNS_PROVIDER="$(DNS_PROVIDER)" CERTMAGIC_CHALLENGE=dns-01 go run ./cmd/server

run-production-le: build-web
	@if [[ -z "$(DOMAIN)" ]]; then \
		echo "DOMAIN is required. Example: make run-production-le DOMAIN=intercom.example.org"; \
		exit 1; \
	fi
	@TMP_CERT_DIR="/tmp/kesher-certs/$(DOMAIN)"; \
	TMP_CERT_FILE="$$TMP_CERT_DIR/fullchain.pem"; \
	TMP_KEY_FILE="$$TMP_CERT_DIR/privkey.pem"; \
	if [[ -f "$$TMP_CERT_FILE" && -f "$$TMP_KEY_FILE" ]]; then \
		echo "Using existing certs in $$TMP_CERT_DIR"; \
	else \
		if ! sudo test -f "/etc/letsencrypt/live/$(DOMAIN)/fullchain.pem" || ! sudo test -f "/etc/letsencrypt/live/$(DOMAIN)/privkey.pem"; then \
			echo "Let's Encrypt cert files not found for DOMAIN=$(DOMAIN)"; \
			echo "Expected:"; \
			echo "  /etc/letsencrypt/live/$(DOMAIN)/fullchain.pem"; \
			echo "  /etc/letsencrypt/live/$(DOMAIN)/privkey.pem"; \
			exit 1; \
		fi; \
		echo "Copying certs to $$TMP_CERT_DIR via sudo..."; \
		sudo mkdir -p "$$TMP_CERT_DIR"; \
		sudo cp "/etc/letsencrypt/live/$(DOMAIN)/fullchain.pem" "$$TMP_CERT_FILE"; \
		sudo cp "/etc/letsencrypt/live/$(DOMAIN)/privkey.pem" "$$TMP_KEY_FILE"; \
		sudo chown "$$(id -u):$$(id -g)" "$$TMP_CERT_FILE" "$$TMP_KEY_FILE"; \
		chmod 644 "$$TMP_CERT_FILE"; \
		chmod 600 "$$TMP_KEY_FILE"; \
	fi; \
	cd backend && sudo env "PATH=$$PATH" STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false PRODUCTION_MODE=true TLS_CERT_FILE="$$TMP_CERT_FILE" TLS_KEY_FILE="$$TMP_KEY_FILE" go run ./cmd/server

run-production-certmagic: build-web
	@if [[ -z "$(DOMAIN)" ]]; then \
		echo "DOMAIN is required. Example: make run-production-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare"; \
		exit 1; \
	fi
	@if [[ -z "$(DNS_PROVIDER)" ]]; then \
		echo "DNS_PROVIDER is required. Example values: cloudflare, hetzner, route53"; \
		exit 1; \
	fi
	@cd backend && sudo env "PATH=$$PATH" STATIC_DIR=../web/dist TRUSTED_LAN_HTTP=false PRODUCTION_MODE=true TLS_MODE=certmagic CERTMAGIC_DOMAINS="$(DOMAIN)" CERTMAGIC_DNS_PROVIDER="$(DNS_PROVIDER)" CERTMAGIC_CHALLENGE=dns-01 go run ./cmd/server


build-web:
	@cd web && npm run build

sync-embedded-web: build-web
	@mkdir -p backend/internal/app/embedded_web
	@cp -R web/dist/. backend/internal/app/embedded_web/

build-backend: sync-embedded-web
	@mkdir -p backend/bin
	@cd backend && \
		VERSION=$$(git describe --tags --always --dirty 2>/dev/null || echo "dev") && \
		BUILD_TIMESTAMP=$$(date -u +'%Y-%m-%dT%H:%M:%SZ') && \
		go build -ldflags="-X github.com/KesherCom/kesher/backend/internal/app.Version=$$VERSION -X github.com/KesherCom/kesher/backend/internal/app.BuildTimestamp=$$BUILD_TIMESTAMP" -o ./bin/server ./cmd/server
build: build-backend

test:
	@cd backend && go test ./...
	@cd web && npm run build

loadtest:
	@cd backend && LOADTEST_RUN=1 go test -tags=loadtest -run TestRealWorldLoadRamp -count=1 -v -timeout 30m ./internal/app

loadtest-20:
	@cd backend && LOADTEST_RUN=1 LOADTEST_PROFILE=20clients go test -tags=loadtest -run TestRealWorldLoadRamp -count=1 -v -timeout 30m ./internal/app

docker-build:
	@docker compose -f deploy/compose/docker-compose.yml build

docker-up:
	@docker compose -f deploy/compose/docker-compose.yml up --build

docker-down:
	@docker compose -f deploy/compose/docker-compose.yml down

clean:
	@rm -rf backend/bin
	@rm -rf web/dist
