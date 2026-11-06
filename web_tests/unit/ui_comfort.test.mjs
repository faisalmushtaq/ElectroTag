// Comfort for long sessions, the pure parts: the working-time clock that stops while paused
// (js/annotate/clock.js) and each annotator's display comfort (js/ui/comfort.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BREAK_MIN_S, SNOOZE_S, WorkClock, breakKey, carriedBreak, idleDue, newestCarry, todayKey } from '../../electrotag/web/static/js/annotate/clock.js';
import { DEFAULT_COMFORT, MIN_NAME_PX, nameEvery, namePx, normaliseComfort, traceWidths } from '../../electrotag/web/static/js/ui/comfort.js';

/** A clock whose time (milliseconds) the test moves by hand. */
function fakeClock(o = {}) {
  let t = 1000;
  const c = new WorkClock({ ...o, now: () => t });
  return { c, wait: (s) => { t += s * 1000; }, at: () => t };
}

// ------------------------------------------------------------------ the clock

test('the clock counts the time open, and stops while paused', () => {
  const { c, wait } = fakeClock({ baseS: 100 });
  wait(30);
  assert.equal(c.elapsedS, 130, 'a restored draft\'s time comes first');
  assert.deepEqual(c.pause('button'), { reason: 'button', at: 31000, elapsedS: 130 });
  assert.equal(c.paused, true);
  assert.equal(c.pause('key'), null, 'a second pause changes nothing');
  wait(600);
  assert.equal(c.elapsedS, 130, 'stopped');
  assert.equal(c.pausedForS, 600);
  assert.equal(c.pauseReason, 'button');
  const r = c.resume();
  assert.deepEqual(r, { reason: 'button', pausedS: 600, isBreak: true });
  assert.equal(c.resume(), null);
  wait(5);
  assert.equal(c.elapsedS, 135);
  assert.equal(c.pausedTotalS, 600);
  assert.equal(c.nPauses, 1);
});

test('a pause can start earlier (the page hidden since then), never before the clock last ran', () => {
  const { c, wait, at } = fakeClock();
  wait(20);
  const hiddenAt = at();
  wait(15);
  c.pause('hidden', hiddenAt);
  assert.equal(c.elapsedS, 20, 'the 15 s out of sight are not counted');
  wait(5);
  assert.equal(c.resume().pausedS, 20);
  wait(1);
  c.pause('hidden', 0);
  assert.equal(c.elapsedS, 20, 'a pause from long ago starts no earlier than the resume');
});

test('the break reminder: due after the interval of work, put off by Remind me later, reset by a break', () => {
  const { c, wait } = fakeClock({ sinceBreakS: 600 });
  assert.equal(c.breakDue(0), false, '0 turns reminders off');
  wait(2399);
  assert.equal(c.breakDue(3000), false);
  wait(1);
  assert.equal(c.breakDue(3000), true, 'work carried over from the recording before counts');
  c.snooze();
  assert.equal(c.breakDue(3000), false);
  wait(SNOOZE_S - 1);
  assert.equal(c.breakDue(3000), false);
  wait(1);
  assert.equal(c.breakDue(3000), true);
  // A short pause is no break; one of at least BREAK_MIN_S is.
  c.pause('button');
  assert.equal(c.breakDue(3000), false, 'never while paused');
  wait(BREAK_MIN_S - 1);
  assert.equal(c.resume().isBreak, false);
  assert.equal(c.breakDue(3000), true);
  c.pause('button');
  wait(BREAK_MIN_S);
  assert.equal(c.resume().isBreak, true);
  assert.equal(c.sinceBreakS, 0);
  assert.equal(c.breakDue(3000), false);
  wait(3000);
  assert.equal(c.breakDue(3000), true, 'the study\'s interval again after a break');
  c.pause('break');
  wait(1);
  assert.equal(c.resume().isBreak, true, 'Take a break counts as a break however short');
  assert.equal(c.sinceBreakS, 0);
});

test('the work since the last break lasts the whole session: carried to the next recording, with a reminder put off', () => {
  const T = Date.UTC(2026, 10, 6, 9, 0, 0);
  // 40 minutes of work, the reminder put off: the next recording starts from both
  const { c, wait } = fakeClock({ sinceBreakS: 600 });
  wait(1800);
  c.snooze();
  const carry = c.carry(T);
  assert.deepEqual(carry, { s: 2400, remindAtS: 2400 + SNOOZE_S, at: T });
  const next = carriedBreak(carry, T + 60 * 1000);
  assert.deepEqual(next, { sinceBreakS: 2400, remindAtS: 2400 + SNOOZE_S });
  const { c: c2, wait: w2 } = fakeClock(next);
  assert.equal(c2.breakDue(3000), false, 'put off on the recording before, so not asked again straight away');
  w2(SNOOZE_S);
  assert.equal(c2.breakDue(3000), true, 'asked again after the quarter of an hour, whichever recording is open');
  // away from the recordings for a break: nothing carries
  assert.deepEqual(carriedBreak(carry, T + BREAK_MIN_S * 1000), { sinceBreakS: 0, remindAtS: null });
  assert.deepEqual(carriedBreak(carry, T + BREAK_MIN_S * 1000 - 1).sinceBreakS, 2400);
  // a pause: the time away counts from when it began, so a reload during a long pause finds a break
  const { c: p, wait: pw } = fakeClock({ sinceBreakS: 100 });
  pw(60);
  p.pause('button');
  pw(240);
  const paused = p.carry(T);
  assert.equal(paused.s, 160);
  assert.equal(paused.at, T - 240 * 1000);
  assert.equal(carriedBreak(paused, T + 59 * 1000).sinceBreakS, 160);
  assert.equal(carriedBreak(paused, T + 61 * 1000).sinceBreakS, 0, 'four minutes paused and a minute more away make a break');
  // Take a break has begun the break: nothing carries, however short
  const { c: b } = fakeClock({ sinceBreakS: 2000 });
  b.pause('break');
  assert.deepEqual(carriedBreak(b.carry(T), T + 1000), { sinceBreakS: 0, remindAtS: null });
});

test('the carry kept in this browser: per annotator, the newest of two, and nothing for what cannot be read', () => {
  const T = 1_800_000_000_000;
  assert.equal(breakKey('A01'), 'electrotag.sinceBreak|A01');
  assert.notEqual(breakKey('A01'), breakKey('A02'));
  const older = { s: 100, remindAtS: null, at: T - 1000 };
  const newer = { s: 30, remindAtS: null, at: T };
  assert.equal(newestCarry(older, newer), newer);
  assert.equal(newestCarry(newer, older), newer);
  assert.equal(newestCarry(null, older), older, 'after a reload, this browser\'s copy');
  assert.equal(newestCarry(older, null), older);
  assert.equal(newestCarry(null, null), null);
  for (const bad of [null, undefined, 'x', {}, { s: 'a', at: T }, { s: -1, at: T }, { s: 10 }, { s: 10, at: 'soon' }]) {
    assert.deepEqual(carriedBreak(bad, T), { sinceBreakS: 0, remindAtS: null }, JSON.stringify(bad));
  }
  assert.equal(carriedBreak({ s: 10, at: T + 30 * 1000 }, T).sinceBreakS, 10, 'a clock a little ahead is no break');
  assert.equal(carriedBreak({ s: 10, at: T + 2 * 60 * 1000 }, T).sinceBreakS, 0, 'one far ahead cannot be trusted');
  assert.equal(carriedBreak({ s: 10, remindAtS: 'later', at: T }, T).remindAtS, null);
  assert.equal(new WorkClock({ remindAtS: -5 }).remindAtS, null);
});

test('a pause after a while without input, and today\'s key', () => {
  assert.equal(idleDue(179999, 3), false);
  assert.equal(idleDue(180000, 3), true);
  assert.equal(idleDue(1e9, 0), false, '0 never pauses');
  assert.equal(todayKey('A01', new Date(2026, 0, 5, 23, 59)), 'electrotag.worked|A01|2026-01-05');
});

// ------------------------------------------------------------ display comfort

test('display comfort: unknown choices fall back, traces and names in whole pixels', () => {
  assert.deepEqual(normaliseComfort(null), DEFAULT_COMFORT);
  assert.deepEqual(normaliseComfort({ trace: 'thick', names: 'huge', panel: 'large', toString: 'x' }), { trace: 'thick', names: 'normal', panel: 'large' });
  assert.deepEqual(normaliseComfort({ trace: 'constructor' }), DEFAULT_COMFORT);
  assert.deepEqual(traceWidths('normal', 2), { device: 2, css: 1 });
  assert.deepEqual(traceWidths('thin', 2), { device: 1, css: 0.6 });
  assert.deepEqual(traceWidths('thick', 2), { device: 4, css: 2 });
  assert.equal(traceWidths('thick', 1).device, 2);
  assert.equal(traceWidths('normal', 1, true).css, 0.6);
  for (const rowH of [4, 8, 12, 20, 40]) {
    assert.ok(Number.isInteger(namePx('normal', rowH)) && Number.isInteger(namePx('large', rowH)));
    assert.ok(namePx('large', rowH) >= namePx('normal', rowH));
  }
  assert.equal(namePx('normal', 40), 12);
  assert.equal(namePx('large', 40), 15);
});

test('channel names are never drawn below 11 pixels (13 when large): short rows name every second or third channel', () => {
  for (const rowH of [2, 4, 5.5, 8.9, 12, 20]) {
    assert.ok(namePx('normal', rowH) >= MIN_NAME_PX.normal && namePx('normal', rowH) <= 12);
    assert.ok(namePx('large', rowH) >= MIN_NAME_PX.large && namePx('large', rowH) <= 15);
    // the names drawn are at least a name's height apart
    const every = nameEvery(namePx('normal', rowH), rowH);
    assert.ok(every * rowH >= namePx('normal', rowH) - 1, `rows of ${rowH} px: every ${every}`);
  }
  assert.equal(nameEvery(12, 20), 1, 'rows tall enough: every channel is named');
  assert.equal(nameEvery(11, 8.9), 2, '22 channels on a short screen: every second');
  assert.equal(nameEvery(11, 5), 2);
  assert.equal(nameEvery(11, 3), 4, '128 channels on a laptop: every fourth');
});
