import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStation, clockAt, normalizeItem, parseDayStart, resolve, skewFromResponse } from './52hertz.js';

const ordered = () => buildStation({
  id: 'demo',
  name: 'Demo',
  epoch: 1000,
  mode: 'order',
  tracks: [
    { url: 'a.mp3', duration: 10, title: 'A' },
    { url: 'b.mp3', duration: 20, title: 'B' },
  ],
});

test('ordered clock joins the exact shared slot and offset', () => {
  const station = ordered();
  const pos = resolve(station, 1014);
  assert.equal(pos.state, 'on-air');
  assert.equal(pos.item.title, 'B');
  assert.equal(pos.offset, 4);
  assert.equal(pos.slotStart, 1010);
  assert.equal(pos.slotEnd, 1030);
});

test('the same station and instant always resolve identically', () => {
  const a = ordered();
  const b = ordered();
  for (const time of [1000, 1009.5, 1010, 1029.9, 1030, 9999.25]) {
    assert.deepEqual(resolve(a, time), resolve(b, time));
  }
});

test('shuffle is deterministic across independently built stations', () => {
  const raw = {
    id: 'shuffle-demo', epoch: 1000, mode: 'shuffle',
    tracks: [
      { url: 'z.mp3', duration: 11 },
      { url: 'a.mp3', duration: 13 },
      { url: 'm.mp3', duration: 17 },
    ],
  };
  const a = buildStation(raw);
  const b = buildStation(structuredClone(raw));
  for (let time = 1000; time < 1600; time += 7) {
    const pa = resolve(a, time);
    const pb = resolve(b, time);
    assert.equal(pa.item.url, pb.item.url);
    assert.equal(pa.offset, pb.offset);
  }
});

test('an empty station is valid and resolves off air', () => {
  const station = buildStation({ id: 'quiet', epoch: 1000, tracks: [] });
  assert.equal(station.passLength, 0);
  assert.deepEqual(resolve(station, 2000), { state: 'off-air', reason: 'empty' });
});

test('future station is off air until epoch', () => {
  const station = ordered();
  assert.deepEqual(resolve(station, 999), { state: 'off-air', reason: 'not-yet', backAt: 1000 });
});

test('dayStart requires a valid IANA timezone and valid time', () => {
  const base = { epoch: 0, tracks: [{ url: 'a.mp3', duration: 10 }] };
  assert.throws(() => buildStation({ ...base, dayStart: '25:00', timezone: 'UTC' }), /invalid dayStart/);
  assert.throws(() => buildStation({ ...base, dayStart: '06:00' }), /needs timezone/);
  assert.throws(() => buildStation({ ...base, dayStart: '06:00', timezone: 'Mars/Olympus' }), /invalid timezone/);
  assert.equal(buildStation({ ...base, dayStart: '06:00', timezone: 'UTC' }).timezone, 'UTC');
});

test('dayStart clock resets at the requested local broadcast boundary', () => {
  const station = buildStation({
    id: 'daily', epoch: 0, mode: 'order', dayStart: '06:00', timezone: 'UTC',
    tracks: [{ url: 'a.mp3', duration: 100 }],
  });
  const six = Date.UTC(2026, 0, 2, 6, 0, 0) / 1000;
  const at = clockAt(station, six);
  assert.equal(at.t, 0);
  assert.equal(at.dayKey, '2026-01-02');
  assert.equal(resolve(station, six).offset, 0);
});


test('dayStart handles a DST spring-forward gap by starting at the first real minute after it', () => {
  const station = buildStation({
    id: 'spring', epoch: 0, mode: 'order', dayStart: '02:30', timezone: 'America/New_York',
    tracks: [{ url: 'a.mp3', duration: 3600 }],
  });
  const before = Date.parse('2026-03-08T06:59:00Z') / 1000; // 01:59 local
  const after = Date.parse('2026-03-08T07:00:00Z') / 1000;  // 03:00 local; 02:30 does not exist
  assert.equal(clockAt(station, before).dayKey, '2026-03-07');
  assert.equal(clockAt(station, after).dayKey, '2026-03-08');
  assert.equal(clockAt(station, after).t, 0);
});

test('dayStart uses the first occurrence of a repeated DST wall-clock minute', () => {
  const station = buildStation({
    id: 'fall', epoch: 0, mode: 'order', dayStart: '01:30', timezone: 'America/New_York',
    tracks: [{ url: 'a.mp3', duration: 3600 }],
  });
  const first = Date.parse('2026-11-01T05:30:00Z') / 1000;  // first 01:30 local
  const second = Date.parse('2026-11-01T06:30:00Z') / 1000; // repeated 01:30 local
  assert.equal(clockAt(station, first).t, 0);
  assert.equal(clockAt(station, first).dayKey, '2026-11-01');
  assert.equal(clockAt(station, second).t, 3600);
  assert.equal(clockAt(station, second).dayKey, '2026-11-01');
});

test('normalization drops non-finite and non-positive durations', () => {
  assert.equal(normalizeItem({ url: 'a', duration: Infinity }), null);
  assert.equal(normalizeItem({ url: 'a', duration: NaN }), null);
  assert.equal(normalizeItem({ url: 'a', duration: 0 }), null);
  assert.equal(normalizeItem({ url: 'a', duration: -1 }), null);
});

test('parseDayStart is strict about clock shape', () => {
  assert.deepEqual(parseDayStart('6:05'), { hour: 6, minute: 5 });
  assert.equal(parseDayStart('6:5'), null);
  assert.equal(parseDayStart('24:00'), null);
});

test('skew uses midpoint and ignores cache-marked responses', () => {
  const headers = new Headers({ date: 'Thu, 01 Jan 1970 00:00:10 GMT' });
  assert.equal(skewFromResponse({ headers }, 9000, 11000), 0.5);
  headers.set('x-fnr-cache', 'hit');
  assert.equal(skewFromResponse({ headers }, 9000, 11000), 0);
});
