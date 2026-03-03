# TODO

- Fully fix audio source indication for all modes/scopes (including always-on + broadcast) using authoritative server-side route metadata instead of client inference fallbacks.
- Consider removing/reworking per-track incoming-audio analyzer badges (`incomingAudioActive` / `isReceiving*`) to reduce client CPU overhead.
