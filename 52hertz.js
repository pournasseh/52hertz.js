/**
 * 52hertz — deterministic shared-clock radio playout.
 *
 * Source of truth: the `52hertz.js` package. Apps (e.g. 52hertz-lite) vendor a
 * copy of this file may be vendored by applications that need a static local copy.
 *
 *     t      = nowSec - clockEpoch
 *     cycle  = floor(t / passLength)
 *     within = t mod passLength
 *
 * clockEpoch is either the station epoch, or today's dayStart in the
 * station timezone (so every broadcast day restarts at e.g. 06:00).
 *
 * mode "shuffle": seeded permutation per cycle
 * mode "order": playlist order every cycle
 */

const hash32 = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const mulberry32 = (a) => () => {
  a = a + 0x6D2B79F5 | 0;
  let x = Math.imul(a ^ a >>> 15, 1 | a);
  x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
  return ((x ^ x >>> 14) >>> 0) / 4294967296;
};

const shuffled = (list, rnd) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
};

/** Turn leftover literal \n sequences into real newlines (bad JSON exports). */
function decodeDescription(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
}

/** Parse "HH:MM" or "H:MM" → { hour, minute } or null. */
export function parseDayStart(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const zonedFormatters = new Map();
const boundaryCache = new Map();

function zonedFormatter(timeZone) {
  if (!zonedFormatters.has(timeZone)) {
    zonedFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return zonedFormatters.get(timeZone);
}

function zonedParts(unixSec, timeZone) {
  const dtf = zonedFormatter(timeZone);
  const map = {};
  for (const p of dtf.formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Unix seconds for a local civil minute in a timezone.
 *
 * DST makes two cases non-trivial:
 * - a repeated wall-clock minute occurs twice when clocks go backward; use the
 *   first occurrence, so the broadcast day starts the first time the clock
 *   reaches the requested time;
 * - a skipped wall-clock minute does not exist when clocks jump forward; use
 *   the first real minute after the gap on that same local date.
 *
 * The result is cached by civil minute, so the bounded scan is paid at most
 * once per broadcast day and timezone in a player session.
 */
function zonedTimeToUnix(y, month, d, h, min, sec, timeZone) {
  if (sec !== 0) throw new Error('broadcast day boundaries require whole minutes');
  const key = `${timeZone}|${y}-${pad2(month)}-${pad2(d)}|${pad2(h)}:${pad2(min)}`;
  if (boundaryCache.has(key)) return boundaryCache.get(key);

  const wantedMinute = h * 60 + min;
  const naive = Math.floor(Date.UTC(y, month - 1, d, h, min, 0) / 1000);
  const start = naive - 18 * 3600;
  const end = naive + 18 * 3600;
  let firstAfterGap = null;

  for (let candidate = start; candidate <= end; candidate += 60) {
    const p = zonedParts(candidate, timeZone);
    if (p.year !== y || p.month !== month || p.day !== d || p.second !== 0) continue;
    const localMinute = p.hour * 60 + p.minute;
    if (localMinute === wantedMinute) {
      boundaryCache.set(key, candidate);
      return candidate;
    }
    if (localMinute > wantedMinute && firstAfterGap === null) {
      firstAfterGap = candidate;
    }
  }

  if (firstAfterGap !== null) {
    boundaryCache.set(key, firstAfterGap);
    return firstAfterGap;
  }
  throw new Error('could not resolve station dayStart in timezone');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Effective on-air clock for this instant.
 * @returns {{ clockEpoch, dayKey, t } | { off: true, reason, backAt? }}
 */
export function clockAt(station, nowSec) {
  if (!Number.isFinite(nowSec)) return { off: true, reason: 'empty' };
  if (nowSec < station.epoch) {
    return { off: true, reason: 'not-yet', backAt: station.epoch };
  }

  const start = station.dayStart;
  if (!start) {
    return {
      clockEpoch: station.epoch,
      dayKey: '',
      t: nowSec - station.epoch,
    };
  }

  const tz = station.timezone || 'UTC';
  const p = zonedParts(nowSec, tz);
  let dayEpoch = zonedTimeToUnix(p.year, p.month, p.day, start.hour, start.minute, 0, tz);
  let y = p.year;
  let m = p.month;
  let d = p.day;

  if (nowSec < dayEpoch) {
    const prev = new Date(Date.UTC(p.year, p.month - 1, p.day) - 86400000);
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
    dayEpoch = zonedTimeToUnix(y, m, d, start.hour, start.minute, 0, tz);
  }

  if (dayEpoch < station.epoch) {
    // First partial day: run from station epoch until the next dayStart.
    return {
      clockEpoch: station.epoch,
      dayKey: `${y}-${pad2(m)}-${pad2(d)}`,
      t: nowSec - station.epoch,
    };
  }

  return {
    clockEpoch: dayEpoch,
    dayKey: `${y}-${pad2(m)}-${pad2(d)}`,
    t: nowSec - dayEpoch,
  };
}

/** Normalize one track; drop anything that cannot be on the air. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.disabled === true) return null;
  const url = String(raw.url || '').trim();
  const duration = Number(raw.duration);
  if (!url || !Number.isFinite(duration) || !(duration > 0)) return null;
  return {
    url,
    duration,
    title: String(raw.title || '').trim(),
    credit: String(raw.credit || '').trim(),
    artUrl: String(raw.artUrl || '').trim(),
    description: decodeDescription(String(raw.description || '').trim()),
    link: String(raw.link || '').trim(),
  };
}

/**
 * Build a playable station from station.json.
 * Shuffle mode sorts by url so JSON key order cannot desync listeners.
 * Order mode keeps playlist order from the file.
 */
export function buildStation(data) {
  if (!data || typeof data !== 'object') throw new Error('unreadable station');
  const id = String(data.id || '').trim() || 'station';
  const epoch = Number(data.epoch);
  if (!Number.isFinite(epoch)) throw new Error('station has no epoch');

  const mode = String(data.mode || '').toLowerCase() === 'order' ? 'order' : 'shuffle';
  const dayStartRaw = String(data.dayStart || '').trim();
  const dayStart = parseDayStart(dayStartRaw);
  if (dayStartRaw && !dayStart) throw new Error('station has invalid dayStart');

  const timezone = String(data.timezone || '').trim();
  if (dayStart && !timezone) throw new Error('station dayStart needs timezone');
  if (dayStart) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    } catch {
      throw new Error('station has invalid timezone');
    }
  }

  let tracks = (Array.isArray(data.tracks) ? data.tracks : [])
    .map((t) => normalizeItem(t))
    .filter(Boolean);

  if (mode === 'shuffle') {
    tracks = tracks.slice().sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  }

  const passLength = tracks.reduce((n, x) => n + x.duration, 0);

  return {
    id,
    name: String(data.name || id).trim(),
    tagline: String(data.tagline || '').trim(),
    accent: /^#[0-9a-f]{6}$/i.test(String(data.accent || ''))
      ? String(data.accent).toLowerCase()
      : '#6a7f8c',
    language: String(data.language || 'en').trim() || 'en',
    logoUrl: String(data.logoUrl || '').trim(),
    artUrl: String(data.artUrl || '').trim(),
    homeUrl: String(data.homeUrl || '').trim(),
    colophon: String(data.colophon || '').trim(),
    mode,
    dayStart,
    timezone: dayStart ? timezone : '',
    epoch,
    tracks,
    passLength,
  };
}

/** One pass: every track once. */
function programme(station, cycle, dayKey) {
  let tracks;
  if (station.mode === 'order') {
    tracks = station.tracks.slice();
  } else {
    const seed = dayKey
      ? station.id + ':' + dayKey + ':' + cycle
      : station.id + ':' + cycle;
    tracks = shuffled(station.tracks, mulberry32(hash32(seed)));
  }
  const prog = [];
  let acc = 0;
  for (const it of tracks) {
    prog.push({ ...it, at: acc });
    acc += it.duration;
  }
  return prog;
}

/**
 * Where the station is at a given unix-second time.
 * @returns {{ state, item, offset, cycle, index, prog, slotStart, slotEnd, next, dayKey? }}
 */
export function resolve(station, nowSec) {
  if (!station || !(station.passLength > 0)) {
    return { state: 'off-air', reason: 'empty' };
  }

  const clock = clockAt(station, nowSec);
  if (clock.off) {
    return { state: 'off-air', reason: clock.reason, backAt: clock.backAt };
  }

  const { clockEpoch, dayKey, t } = clock;
  const cycle = Math.floor(t / station.passLength);
  const within = t - cycle * station.passLength;
  const prog = programme(station, cycle, dayKey);

  let i = 0;
  while (i < prog.length - 1 && prog[i].at + prog[i].duration <= within) i++;

  const item = prog[i];
  const offset = Math.max(0, within - item.at);
  const cycleStart = clockEpoch + cycle * station.passLength;
  const slotStart = cycleStart + item.at;
  const slotEnd = slotStart + item.duration;

  const next = i + 1 < prog.length
    ? prog[i + 1]
    : programme(station, cycle + 1, dayKey)[0];

  return {
    state: 'on-air',
    item,
    offset,
    cycle,
    index: i,
    prog,
    slotStart,
    slotEnd,
    next,
    dayKey,
  };
}

/** Estimate host clock skew from a fetch Response's Date header (seconds). */
export function skewFromResponse(res, t0, t1) {
  const stamp = res.headers.get('date');
  if (!stamp || res.headers.get('x-fnr-cache')) return 0;
  const server = Date.parse(stamp);
  if (!Number.isFinite(server)) return 0;
  const mid = t1 - (t1 - t0) / 2;
  return (server + 500 - mid) / 1000;
}
