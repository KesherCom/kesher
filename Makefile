SHELL := /bin/bash
LAN_IP ?= 127.0.0.1
DESKTOP_PROXY_VERSION ?= dev
DESKTOP_PROXY_DIST_DIR ?= desktop-proxy/dist
DESKTOP_PROXY_PLATFORMS ?= darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: help deps dev-backend dev-web run-backend run-backend-https run-backend-le run-backend-certmagic run-production-le run-production-certmagic run-web run-desktop-proxy sync-embedded-web build-backend build-web build-desktop-proxy build-desktop-proxy-all package-desktop-proxy build test docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make deps          - install backend/web dependencies"
	@echo "  make dev-backend   - run Go backend in dev mode"
	@echo "  make dev-web       - run React frontend dev server"
	@echo "  make run-backend   - run backend serving built frontend assets"
	@echo "  make run-backend-https - run backend with HTTPS; auto-generate self-signed certs if missing (LAN_IP=... optional)"
	@echo "  make run-backend-le DOMAIN=... - run backend with HTTPS using Let's Encrypt certs from /etc/letsencrypt/live/\$$DOMAIN/"
	@echo "  make run-backend-certmagic DOMAIN=... DNS_PROVIDER=... - run backend with CertMagic ACME DNS-01 automation"
	@echo "  make run-production-le DOMAIN=... - production mode (HTTPS :443 + HTTP :80 redirect) with Let's Encrypt certs"
	@echo "  make run-production-certmagic DOMAIN=... DNS_PROVIDER=... - production mode with in-app CertMagic DNS-01 automation"
	@echo "  make run-desktop-proxy UPSTREAM=... [CA_FILE=...] [PINS=...] [SKIP_PREFLIGHT=1] - run localhost desktop launcher/proxy"
	@echo "  make run-web       - alias for dev-web"
	@echo "  make sync-embedded-web - copy web/dist into backend embedded assets directory"
	@echo "  make build-backend - build backend binary"
	@echo "  make build-web     - build frontend bundle"
	@echo "  make build-desktop-proxy - build desktop proxy binary"
	@echo "  make build-desktop-proxy-all [DESKTOP_PROXY_VERSION=...] - cross-build desktop proxy binaries"
	@echo "  make package-desktop-proxy [DESKTOP_PROXY_VERSION=...] - cross-build + SHA256 checksums"
	@echo "  make build         - build backend + frontend"
	@echo "  make test          - run backend tests + frontend build"
	@echo "  make docker-build  - build Docker image via compose"
	@echo "  make docker-up     - run app via Docker compose"
	@echo "  make docker-down   - stop Docker compose app"
	@echo "  make clean         - remove common build artifacts"

deps:
	@cd backend && go mod tidy
	@cd desktop-proxy && go mod tidy
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
	@TMP_CERT_DIR="/tmp/live-production-intercom-certs/$(DOMAIN)"; \
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
	@TMP_CERT_DIR="/tmp/live-production-intercom-certs/$(DOMAIN)"; \
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

run-desktop-proxy:
	@if [[ -z "$(UPSTREAM)" ]]; then \
		echo "UPSTREAM is required. Example: make run-desktop-proxy UPSTREAM=http://192.168.1.50:8080"; \
		exit 1; \
	fi
	@cd desktop-proxy && go run ./cmd/desktop-proxy --upstream "$(UPSTREAM)" $(if $(CA_FILE),--ca-file "$(CA_FILE)",) $(if $(PINS),--pins "$(PINS)",) $(if $(PRECHECK_PATH),--preflight-path "$(PRECHECK_PATH)",) $(if $(SKIP_PREFLIGHT),--skip-preflight,)


build-web:
	@cd web && npm run build

sync-embedded-web: build-web
	@mkdir -p backend/internal/app/embedded_web
	@cp -R web/dist/. backend/internal/app/embedded_web/

build-backend: sync-embedded-web
	@mkdir -p backend/bin
	@cd backend && go build -o ./bin/server ./cmd/server

build-desktop-proxy:
	@mkdir -p desktop-proxy/bin
	@cd desktop-proxy && go build -o ./bin/desktop-proxy ./cmd/desktop-proxy
build-desktop-proxy-all:
	@mkdir -p "$(DESKTOP_PROXY_DIST_DIR)/$(DESKTOP_PROXY_VERSION)"
	@for target in $(DESKTOP_PROXY_PLATFORMS); do \
		GOOS=$${target%/*}; \
		GOARCH=$${target#*/}; \
		EXT=""; \
		if [[ "$$GOOS" == "windows" ]]; then EXT=".exe"; fi; \
		OUT="$(DESKTOP_PROXY_DIST_DIR)/$(DESKTOP_PROXY_VERSION)/desktop-proxy-$$GOOS-$$GOARCH$$EXT"; \
		echo "Building $$OUT"; \
		( cd desktop-proxy && GOOS=$$GOOS GOARCH=$$GOARCH CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "../$$OUT" ./cmd/desktop-proxy ); \
	done

package-desktop-proxy: build-desktop-proxy-all
	@cd "$(DESKTOP_PROXY_DIST_DIR)/$(DESKTOP_PROXY_VERSION)" && \
	shasum -a 256 desktop-proxy-* > SHA256SUMS.txt

build: build-backend build-desktop-proxy

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
	@rm -rf desktop-proxy/bin
	@rm -rf web/dist

