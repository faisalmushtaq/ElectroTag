// The working-time clock of a recording, as plain functions and a small class that the annotation
// view uses and the unit tests check. The clock counts the time a recording is open and not paused:
// a pause (the Pause button or key, no input for a while, or the page out of sight) stops it, and
// the time worked so far is what drafts and Save and Finish record as elapsed_s. It also keeps the
// time worked since the last break, for the break reminder. That time belongs to the person, not to
// the recording: carry() gives what goes on to the next recording they open (kept in this browser per
// annotator, so a reload or signing in again keeps it too), and carriedBreak() what a recording opened
// later starts from, which is nothing once they have been away from their recordings for a break.

/** A pause at least this long (seconds) counts as a break: the break reminder starts again. */
export const BREAK_MIN_S = 5 * 60;
/** The page out of sight for longer than this (milliseconds) pauses the clock. */
export const HIDDEN_PAUSE_MS = 10 * 1000;
/** "Remind me later" asks again after this many seconds of work. */
export const SNOOZE_S = 15 * 60;
/** Why the clock was paused, as the interaction log records it. */
export const PAUSE_REASONS = Object.freeze(['button', 'key', 'idle', 'hidden', 'break']);

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class WorkClock {
  /**
   * @param {{baseS?: number, sinceBreakS?: number, remindAtS?: number|null, now?: () => number}} o baseS: time
   *   worked before (a restored draft); sinceBreakS: work since the last break carried over from the recording
   *   before, and remindAtS the reminder put off there (carriedBreak); now: a clock in milliseconds
   *   (performance.now by default; the tests give their own).
   */
  constructor({ baseS = 0, sinceBreakS = 0, remindAtS = null, now = nowMs } = {}) {
    this.now = now;
    this.baseS = Math.max(0, Number(baseS) || 0);
    this.startedAt = now();
    this.runningSince = this.startedAt; // null while paused
    this.workedS = 0; // in this session, up to runningSince
    this.breakBaseS = Math.max(0, Number(sinceBreakS) || 0);
    this.pause_ = null; // { reason, at, workedAtS }
    this.pausedTotalS = 0;
    this.nPauses = 0;
    // the work since the last break at which to remind (null: the study's interval)
    this.remindAtS = Number.isFinite(remindAtS) && remindAtS > 0 ? remindAtS : null;
  }

  get paused() { return this.pause_ !== null; }

  /** Seconds worked in this session (pauses excluded), at time `at` (milliseconds). */
  _session(at = this.now()) {
    return this.workedS + (this.runningSince === null ? 0 : Math.max(0, at - this.runningSince) / 1000);
  }

  /** Seconds worked on the recording, earlier sessions included, pauses excluded. */
  get elapsedS() { return this.baseS + this._session(); }

  /** Seconds worked since the last break (a pause of at least BREAK_MIN_S, or Take a break). */
  get sinceBreakS() { return this.breakBaseS + this._session(); }

  /** Seconds the current pause has lasted (0 when running). */
  get pausedForS() { return this.pause_ ? Math.max(0, this.now() - this.pause_.at) / 1000 : 0; }

  get pauseReason() { return this.pause_ ? this.pause_.reason : null; }

  /**
   * Stop the clock. `at` (milliseconds, no later than now) starts the pause earlier, for a page that
   * has been out of sight since then. Returns the pause, or null when already paused.
   */
  pause(reason, at = this.now()) {
    if (this.pause_) return null;
    const when = Math.max(Math.min(at, this.now()), this.runningSince ?? at);
    this.workedS = this._session(when);
    this.runningSince = null;
    this.pause_ = { reason, at: when, elapsedS: this.baseS + this.workedS };
    this.nPauses += 1;
    return { ...this.pause_ };
  }

  /** Start the clock again. Returns { reason, pausedS, isBreak } or null when it was running. */
  resume() {
    if (!this.pause_) return null;
    const now = this.now();
    const pausedS = Math.max(0, now - this.pause_.at) / 1000;
    const { reason } = this.pause_;
    const isBreak = reason === 'break' || pausedS >= BREAK_MIN_S;
    this.pausedTotalS += pausedS;
    this.pause_ = null;
    this.runningSince = now;
    if (isBreak) {
      // A break: the reminder counts again from here.
      this.breakBaseS = -this.workedS;
      this.remindAtS = null;
    }
    return { reason, pausedS, isBreak };
  }

  /** Whether the break reminder is due (`intervalS` of work since the last break; 0 means never). */
  breakDue(intervalS) {
    if (!(intervalS > 0) || this.paused) return false;
    return this.sinceBreakS >= (this.remindAtS ?? intervalS);
  }

  /** "Remind me later": ask again after another `snoozeS` of work. */
  snooze(snoozeS = SNOOZE_S) { this.remindAtS = this.sinceBreakS + snoozeS; }

  /**
   * What carries on to the next recording: {s, remindAtS, at}, the work since the last break, the reminder put
   * off, and when the work stopped (`epochMs`, milliseconds since 1970: now, or when the pause began). During
   * Take a break the break has begun, so nothing carries.
   */
  carry(epochMs = Date.now()) {
    if (this.pause_ && this.pause_.reason === 'break') return { s: 0, remindAtS: null, at: epochMs };
    const stoppedMsAgo = this.pause_ ? Math.max(0, this.now() - this.pause_.at) : 0;
    return { s: Math.round(this.sinceBreakS * 10) / 10, remindAtS: this.remindAtS, at: epochMs - stoppedMsAgo };
  }
}

/** Where this browser keeps an annotator's work since their last break (localStorage). */
export function breakKey(who) { return `electrotag.sinceBreak|${who}`; }

/** Of two carries (the page's own and this browser's copy), the one written last; either may be missing. */
export function newestCarry(a, b) {
  const at = (c) => (c && Number.isFinite(Number(c.at)) ? Number(c.at) : -Infinity);
  return at(b) > at(a) ? b : (a || b || null);
}

/**
 * What a recording opened at `epochMs` starts from: {sinceBreakS, remindAtS}. The carry counts while the person
 * has been away from their recordings for less than BREAK_MIN_S; longer away is a break, and so is a carry that
 * cannot be read or that comes from a clock set later than this one by more than a minute.
 */
export function carriedBreak(carry, epochMs = Date.now()) {
  const fresh = { sinceBreakS: 0, remindAtS: null };
  if (!carry || typeof carry !== 'object') return fresh;
  const s = Number(carry.s);
  const at = Number(carry.at);
  if (!Number.isFinite(s) || s < 0 || !Number.isFinite(at)) return fresh;
  const awayMs = epochMs - at;
  if (awayMs >= BREAK_MIN_S * 1000 || awayMs < -60 * 1000) return fresh;
  const r = carry.remindAtS === null || carry.remindAtS === undefined ? null : Number(carry.remindAtS);
  return { sinceBreakS: s, remindAtS: Number.isFinite(r) && r > 0 ? r : null };
}

/** Whether `idleMs` without input should pause the clock (`idleMinutes` 0 means never). */
export function idleDue(idleMs, idleMinutes) {
  return idleMinutes > 0 && idleMs >= idleMinutes * 60 * 1000;
}

/** The working time of today, kept per annotator and day in this browser (a key of localStorage). */
export function todayKey(who, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `electrotag.worked|${who}|${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
