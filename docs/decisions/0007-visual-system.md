# 0007: One visual system with colors that mean one thing

Date: 2026-10-08 · Status: accepted

## Context

The UI grew screen by screen: green meant "listen" in the station view but
"talk" in the routing matrix, cyan, yellow, blue, red and orange were used
as they came, most labels were small letter-spaced capitals, cards sat in
panels in groups, and there were at least five button styles. In an
intercom, people must read state at a glance under stress.

## Decision

A small visual system, written down in [docs/design](../design/README.md)
and as `--k-*` variables in `packages/client-core/src/styles/tokens.css`:

- Five signal colors with one meaning each: hear (green), on air (red),
  call (yellow), attention (orange), selection (cyan, never a status).
- IBM Plex Sans/Mono, four type sizes, normal case (capitals only on the
  talk button).
- Fixed spacing and radii, 44 px touch targets, one border per layer.
- Three button kinds and one stroke icon set.
- Party line cards: press area plus a row with hear, call and volume;
  a list on phones with a fixed talk bar.

The approved draft is the design canvas "Kesher Redesign Entwurf"
(https://claude.ai/artifact/8u2zw6mdKvHFtbAvEFCvgw).

## Why

- State is readable without learning a color code per screen.
- Fewer boxes and calmer type make the important things (who talks, am I
  on air) stand out.
- Variables make the next screens consistent by default.

## Limits

- `theme.css`/`app.css` still hold the old values; screens move over one by
  one, so for a while old and new styles coexist.
- IBM Plex has to be bundled for offline use (no CDN on a LAN without
  internet).
