# 0006: Shared roles; Stream Decks belong to a place

Date: 2026-10-08 · Status: accepted

## Context

A role could be logged in only once: a second login had to take over. Teams
asked for several people in one role (three camera operators in "Camera").
The blocker was the Stream Deck: a Companion connection was bound to a role
(`?roleId=`) and sent every key press to the newest login of that role, so
with three camera operators all decks would control the same person. Most
setups run one central Companion with the decks attached as satellites, so
the deck cannot be told apart by IP address either.

## Decision

1. **Roles are shared by default.** A role has an `exclusive` flag (admin
   area, Roles). Only exclusive roles keep the "role in use, take over?"
   question; in the example setup that is the Producer.
2. **Role call.** A direct call to a role (Stream Deck action `direct_role`)
   reaches everyone logged in with it. On the wire the direct target is
   `role:<roleId>` instead of a user ID (`directTargetMatches` in
   `hub.go`). "Reply" goes back to the one person who called. A direct call
   to a person reaches all of that person's sessions (WebRTC used to pick a
   random one).
3. **Places.** Every client sends a stable `placeId` at login: browser and
   desktop app keep a random ID in local storage (`lib/place.ts`), a
   Raspberry Pi station uses `station-<device id>`.
4. **One Companion connection per Stream Deck.** The connection names its
   deck (`deck` field: serial number or a name like "Camera 1") and uses
   `?deck=` on all Companion endpoints. The server registers unknown decks
   by itself (`stream_decks` table, `backend/internal/app/stream_decks.go`).
5. **A deck belongs to a place**, and controls whoever is logged in there,
   with that login's rights. An unpaired deck shows a 4-digit code on its
   keys; typing it in the Stream Deck section of the app at that place pairs
   it. The admin area (Stream Decks) can pair, move and remove decks too.
6. **The layout belongs to the deck.** It looks the same whoever sits there.
   Until a layout is saved for the deck it shows the layout of the role
   logged in at its place; the Stream Deck editor at a place with a deck
   edits the deck's layout, never the role's.

Companion state that was keyed by role ID (current page, held keys, result
fan-out, image stream clients) is keyed by `deck:<id>` for deck connections.
Connections with `?roleId=` keep working as before.

## Why

- Decks are physical: they stay at a desk while people and roles change.
  Binding them to the place matches that, and works with satellites.
- Pairing by code needs no serial numbers typed into the admin area and no
  admin at all for a new deck.
- Rights stay with the person's role, so a deck at a desk cannot do more than
  the person logged in there.

## Limits and alternatives

- A place is a browser profile or app installation; clearing the browser's
  storage makes it a new place (pair the deck again).
- Two people logged in at the same place (two tabs, two names) share its
  decks; the newest login wins.
- Layouts per person (the deck follows the person to any desk) were
  considered and left for later; the stored per-deck layout would stay the
  fallback.
- The image stream (`/api/image-stream`) now checks the Companion shared
  secret like the other Companion endpoints; module versions older than this
  change send no secret there, so with a secret set their key images stay
  blank until the module is updated.
