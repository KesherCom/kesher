# Decisions

Short records of design decisions: what was decided, why, and what would
make us revisit it. One file per decision, numbered in order; a decision
that is replaced stays here and links to its successor.

| # | Decision | Date |
| --- | --- | --- |
| [0001](0001-wifi-not-dect.md) | Wireless stations use a dedicated 5 GHz Wi-Fi, not DECT | 2026-10-06 |
| [0002](0002-clients-mix-no-server-premix.md) | Clients mix; the server only forwards audio | 2026-10-06 |
| [0003](0003-silence-suppression-always-on-only.md) | Silence suppression only for always-on mics, one-frame pre-roll | 2026-10-06 |
| [0004](0004-one-repo-shared-audio-engine.md) | One repository; desktop app and Pi node share one audio engine | 2026-10-06 |
| [0005](0005-zero-config-stations.md) | No configuration on stations or during install: discovery, approval in the admin area, LAN HTTP, setup page | 2026-10-08 |
| [0006](0006-shared-roles-and-stream-decks-per-place.md) | Roles are shared by default; Stream Decks belong to a place and have their own layout | 2026-10-08 |
| [0007](0007-visual-system.md) | One visual system: colors with one meaning, type, spacing, buttons, icons | 2026-10-08 |
