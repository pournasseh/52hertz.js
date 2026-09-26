<p align="center"><img src="assets/logo.png" alt="52hertz.js" width="130"></p>

# 52hertz.js

Deterministic shared-clock radio playout. Pure ESM, no dependencies, no audio
API — only math: given a station and a unix time, every listener gets the same
track and offset.

## Install / use

Copy `52hertz.js` into your app or import it directly from a local checkout. It
is pure ESM and has no runtime dependencies.

The companion projects are independent repositories:

- [52Hertz](https://github.com/pournasseh/52hertz)
- [52Hertz Lite](https://github.com/pournasseh/52hertz-lite), which vendors a release snapshot of this primitive.

```js
import { buildStation, resolve } from './52hertz.js';

const station = buildStation(await (await fetch('station.json')).json());
const pos = resolve(station, Date.now() / 1000);
// pos.state === 'on-air' → pos.item, pos.offset, pos.next, …
```

If your host exposes a trustworthy uncached HTTP `Date` header, use
`skewFromResponse(response, t0, t1)` to estimate clock skew before calling
`resolve()`. The helper returns seconds.

## API

| Export | Role |
| --- | --- |
| `buildStation(data)` | Normalize `station.json` → playable station |
| `resolve(station, nowSec)` | Current slot (or off-air) |
| `clockAt(station, nowSec)` | Effective epoch / day key |
| `parseDayStart(raw)` | `"HH:MM"` → `{ hour, minute }` |
| `normalizeItem(raw)` | One track or `null` |
| `skewFromResponse(res, t0, t1)` | Clock skew from `Date` header (seconds) |

## Clock model

```
t      = nowSec - clockEpoch
cycle  = floor(t / passLength)
within = t mod passLength
```

- `mode: "shuffle"` — seeded permutation per cycle (`id` + optional day + cycle)
- `mode: "order"` — playlist order every cycle
- optional `dayStart` + required valid IANA `timezone` — broadcast day restarts at that local time

Wrong track `duration` values desync everyone. Prefer measured lengths. Invalid `dayStart` / timezone values fail at build time; non-finite or non-positive tracks are ignored. A station with no playable tracks is valid and resolves off air instead of inventing a clock.

DST is explicit rather than accidental: if `dayStart` names a skipped local minute during a spring-forward change, that broadcast day starts at the first real minute after the gap. If the wall-clock minute occurs twice during a fall-back change, the first occurrence starts the day.

## Development

`52hertz.js` is the source of truth for the primitive.

```sh
npm test
```

Applications may vendor a copy. Companion repositories synchronize that copy
deliberately when preparing their own releases.

## License

GNU Affero General Public License, version 3 or later. See [`LICENSE`](LICENSE).
