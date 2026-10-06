# 0001: Wireless stations use a dedicated 5 GHz Wi-Fi, not DECT

Date: 2026-10-06 · Status: accepted

## Context

Besides wired stations, Kesher should get wireless ones (beltpacks).
Professional intercoms (Riedel Bolero, Clear-Com FreeSpeak, Green-GO) use
DECT for this.

## Decision

Wireless stations use **Wi-Fi on a dedicated 5 GHz network**:

- own SSID (or VLAN) only for the intercom,
- **non-DFS channels 36 to 48**: on DFS channels a detected radar forces the
  access point off the channel, which can mean up to a minute of silence,
- WMM on, so voice traffic gets the access point's voice queue (marking the
  audio packets DSCP 46 / EF in the engine and the relay is still to do),
- power saving off on the clients (`kesher-node` does this itself).

DECT is not pursued. A SIP-DECT gateway for off-the-shelf DECT handsets
remains a possible later add-on for roles where range matters more than
latency.

## Why

- **Latency.** DECT works in 10 ms frames; end to end it typically reaches
  20 to 40 ms, with SIP-DECT 40 to 80 ms. A clean 5 GHz network adds about 3
  to 10 ms to the wired path, which keeps it close to the <20 ms goal.
- **Audio quality.** DECT carries narrowband (3.4 kHz) or at best G.722
  (7 kHz) audio; Kesher uses 48 kHz Opus.
- **Hardware.** DECT is licence-free to *operate* in the EU (1880 to
  1900 MHz), but building devices needs DECT-certified radio modules, which
  are hard to get for small projects (NDA, minimum quantities), plus patent
  licences. Pre-certified Wi-Fi modules (Pi, ESP32-C5, Radxa) are easy to
  buy and simplify CE conformity.

## Revisit when

- stations must work where the 5 GHz band is crowded and cannot be
  controlled (festival grounds, shared venue Wi-Fi), or
- roaming across many access points proves unreliable in practice.
