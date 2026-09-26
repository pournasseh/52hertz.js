# Changelog

## 0.2.1 — 2026-09-26

- Explicit deterministic behavior across DST spring-forward gaps and fall-back repeated wall-clock minutes.
- Invalid day-start/timezone configuration fails at build time.
- Empty stations are valid and resolve off air.
- Non-finite and non-positive track durations are ignored.
- HTTP `Date` skew helper avoids cache-marked responses.
