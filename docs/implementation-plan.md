# kesher - Live Production Intercom - Remaining core work only

## Problem statement

This document tracks only unimplemented core-app items that remain from the original implementation plan.

## Remaining items

### 1) Enforce real admin authorization for admin APIs

- Replace placeholder admin check with real role-based/admin policy checks.
- Ensure `/api/admin/*` endpoints are not effectively open to all authenticated users.
- Touchpoint: `backend/internal/app/server.go` (`requireAdmin` and admin handlers).

### 2) Optional role-assignment guardrails at login

- Add optional admin-controlled role allowlist/constraints for user login role selection.
- Preserve current unrestricted behavior as default if guardrails are disabled.
- Touchpoints: `backend/internal/app/server.go`, `backend/internal/app/store.go`, potentially config/env wiring in `backend/internal/app/config.go`.

## Done and intentionally removed from this plan

- Core voice/chat/signal routing and presence.
- Party-line/broadcast role policy enforcement for normal realtime flows.
- WebRTC/media path.
- Session TTL support.
- HTTP/HTTPS + production redirect modes.
- Companion integration baseline (tracked in dedicated companion plan).
