SHELL := /bin/bash
LAN_IP ?= 127.0.0.1

.PHONY: help deps dev-backend dev-web run-backend run-backend-no-udp run-backend-https run-backend-le run-backend-certmagic run-production-le run-production-certmagic run-web sync-embedded-web build-backend build-web build-desktop-web build-desktop-windows build-desktop-release run-desktop-release dev-desktop desktop-web-check desktop-rust-check desktop-rust-test desktop-check local-smoke build test ci-test ci-backend-test ci-desktop-test loadtest loadtest-20 docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make deps          - install backend/web dependencies"
	@echo "  make dev-backend   - run Go backend in dev mode"
	@echo "  make dev-web       - run React frontend dev server"
	@echo "  make run-backend   - run backend serving built frontend assets (UDP audio relay :8081 ON)"
	@echo "  make run-backend-no-udp - run backend with the native UDP audio relay disabled (WebRTC only)"
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
	@echo ""
	@echo "  Desktop & CI Targets (local GitHub Actions simulation):"
	@echo "  make build-desktop-web     - build web bundle for desktop"
	@echo "  make build-desktop-windows - build Windows app (MSI + NSIS)"
	@echo "  make build-desktop-macos   - build macOS app (DMG + universal)"
	@echo "  make build-desktop-release - tauri build --no-bundle (raw kesher_desktop.exe, no installer)"
	@echo "  make run-desktop-release   - run the previously built release binary directly"
	@echo "  make dev-desktop           - run Tauri dev server"
	@echo "  make desktop-web-check     - TypeScript + Vite build check for desktop web shell"
	@echo "  make desktop-rust-check    - cargo check for desktop native (Tauri/Rust)"
	@echo "  make desktop-rust-test     - cargo test for the desktop crate (incl. native audio)"
	@echo "  make desktop-check         - run desktop web + native checks + tests"
	@echo "  make local-smoke           - run complete local smoke checks (deps, tests, desktop checks)"
	@echo "  make ci-test               - run full CI test suite"
	@echo "  make ci-backend-test       - test backend builds"
	@echo "  make ci-desktop-test       - test backend + desktop builds"
	@echo ""
	@echo "  make loadtest      - run staged backend load test with non-ideal network simulation"
	@echo "  make loadtest-20   - run staged backend load test profile that ramps to 20 clients"
	@echo "  make docker-build  - build Docker image via compose"
	@echo "  make docker-up     - run app via Docker compose"
	@echo "  make docker-down   - stop Docker compose app"
	@echo "  make clean         - remove common build artifacts"

deps:
	@npm ci || npm install
	@cd backend && go mod download && go mod tidy

dev-backend:
	@cd backend && go run ./cmd/server

dev-web:
	@cd web && npm run dev

run-web: dev-web

# Default: native UDP audio relay listens on :8081 alongside HTTP :8080.
# Override with UDP_AUDIO_ADDR=":9000" make run-backend, or disable via the
# `run-backend-no-udp` target.
run-backend: build-web
	@node -e "const cp=require('child_process');const path=require('path');const env={...process.env,STATIC_DIR:path.join('..','web','dist'),UDP_AUDIO_ADDR:process.env.UDP_AUDIO_ADDR||':8081'};const child=cp.spawn('go',['run','./cmd/server'],{cwd:path.join('backend'),stdio:'inherit',env});child.on('exit',(code)=>process.exit(code??0));child.on('error',(err)=>{console.error('Failed to start backend:',err.message);process.exit(1);});"

run-backend-no-udp: build-web
	@node -e "const cp=require('child_process');const path=require('path');const env={...process.env,STATIC_DIR:path.join('..','web','dist'),UDP_AUDIO_ADDR:''};const child=cp.spawn('go',['run','./cmd/server'],{cwd:path.join('backend'),stdio:'inherit',env});child.on('exit',(code)=>process.exit(code??0));child.on('error',(err)=>{console.error('Failed to start backend:',err.message);process.exit(1);});"

run-backend-https: build-web
	@node -e "const cp=require('child_process');const path=require('path');const env={...process.env,STATIC_DIR:path.join('..','web','dist'),TRUSTED_LAN_HTTP:'false',TLS_MODE:'internal'};const child=cp.spawn('go',['run','./cmd/server'],{cwd:path.join('backend'),stdio:'inherit',env});child.on('exit',(code)=>process.exit(code??0));child.on('error',(err)=>{console.error('Failed to start backend:',err.message);process.exit(1);});"

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
	@node -e "const fs=require('fs');const path=require('path');const src=path.join('web','dist');const dst=path.join('backend','internal','app','embedded_web');fs.mkdirSync(dst,{recursive:true});for(const name of fs.readdirSync(src)){fs.cpSync(path.join(src,name),path.join(dst,name),{recursive:true,force:true});}"

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
	@npm --prefix packages/client-core test

# === Desktop & CI Targets (GitHub Actions local simulation) ===

build-desktop-web: build-web
	@echo "Building desktop web bundle..."
	@cd desktop && npm run build:web

build-desktop-windows: build-desktop-web
	@echo "Building Windows desktop app (MSI + NSIS)..."
	@cd desktop && npm run tauri build

build-desktop-macos: build-desktop-web
	@echo "Building macOS desktop app (DMG + universal)..."
	@cd desktop && npm run tauri build -- --target universal-apple-darwin

# Fast iteration target: produce just the raw kesher_desktop.exe (no MSI/NSIS).
build-desktop-release: build-desktop-web
	@echo "Building desktop release binary (tauri build --no-bundle)..."
	@cd desktop && npm run tauri build -- --no-bundle

run-desktop-release:
	@echo "Running pre-built desktop release binary..."
	@node -e "const fs=require('fs');const cp=require('child_process');const path=require('path');const candidates=['desktop/src-tauri/target/release/kesher_desktop.exe','desktop/src-tauri/target/release/kesher_desktop'];const bin=candidates.find((p)=>fs.existsSync(p));if(!bin){console.error('No release binary found. Run: make build-desktop-release');process.exit(1);}const child=cp.spawn(path.resolve(bin),[],{stdio:'inherit'});child.on('exit',(code)=>process.exit(code??0));child.on('error',(err)=>{console.error('Failed to start release binary:',err.message);process.exit(1);});"

dev-desktop:
	@echo "Starting Tauri dev server..."
	@cd desktop && npm run tauri dev

desktop-web-check:
	@echo "Running desktop web build check..."
	@cd desktop && npm run build:web

desktop-rust-check:
	@echo "Running desktop Rust check..."
	@cd desktop/src-tauri && cargo check

desktop-rust-test:
	@echo "Running desktop Rust tests (incl. native audio)..."
	@cd desktop/src-tauri && cargo test --bin kesher_desktop

desktop-check: desktop-web-check desktop-rust-check desktop-rust-test
	@echo "✓ Desktop checks passed!"

local-smoke: deps test desktop-check
	@echo "✓ Local smoke checks passed!"

ci-backend-test: sync-embedded-web
	@echo "Building backend binaries (Windows + Linux)..."
	@node -e "const fs=require('fs');const cp=require('child_process');fs.mkdirSync('dist/bin',{recursive:true});const run=(args,env)=>{const r=cp.spawnSync('go',args,{cwd:'backend',stdio:'inherit',env:{...process.env,...env}});if(r.status!==0)process.exit(r.status??1);};run(['build','-trimpath','-ldflags=-s -w','-o','../dist/bin/kesher-windows-amd64.exe','./cmd/server'],{});run(['build','-trimpath','-ldflags=-s -w','-o','../dist/bin/kesher-linux-amd64','./cmd/server'],{GOOS:'linux',GOARCH:'amd64',CGO_ENABLED:'0'});"
	@echo "✓ Backend builds complete!"

ci-desktop-test: ci-backend-test build-desktop-windows
	@echo "✓ Desktop + Backend builds complete!"

ci-test: test desktop-check
	@echo "✓ Full CI tests passed!"

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
	@rm -rf desktop/src-tauri/target
	@rm -rf dist/bin dist/packages
	@echo "✓ Build artifacts cleaned"
