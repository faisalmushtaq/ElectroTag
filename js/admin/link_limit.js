// The time limit of a new link to choose a password, shown as a warning beside it. Kept apart from
// model.js, which the demonstration's sign-in page loads, so that only the admin area carries it.

import { dateText, inviteMessage } from './model.js';

/** 14:05, in the administrator's own time. */
export function timeText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Firebase Authentication's link to choose a password stops working an hour after it is made. The
 * limit is Firebase's own (it is not given with the link), so the admin area works it out from when
 * the link was made.
 */
export const FIREBASE_LINK_MINUTES = 60;

/**
 * When a new link to choose a password stops working: `{ at, short }`, `short` for Firebase's hour
 * (the time of day matters), or null when the link has no limit that is known.
 */
export function linkLimit({ expiresAt = null, firebase = false, madeAt = Date.now() } = {}) {
  if (expiresAt) return { at: expiresAt, short: false };
  if (!firebase) return null;
  return { at: new Date(Number(madeAt) + FIREBASE_LINK_MINUTES * 60000).toISOString(), short: true };
}

/** The warning beside new links: when they stop working and what to do then ('' with no limit). */
export function linkLimitText(limit, { count = 1 } = {}) {
  if (!limit) return '';
  const many = count > 1;
  const stops = many ? 'These links stop working' : 'This link stops working';
  if (limit.short) {
    return `${stops} an hour after ${many ? 'they were' : 'it was'} made, at about ${timeText(limit.at)} on ${dateText(limit.at)}: `
      + `Firebase sets this limit. Send ${many ? 'each one' : 'it'} now and ask the person to open it straight away; after that time, make a new link.`;
  }
  return `${stops} on ${dateText(limit.at)}. If the person has not used ${many ? 'theirs' : 'it'} by then, make a new link.`;
}

/**
 * The message of "Email the link" (inviteMessage) for a link with this limit: a short limit
 * (Firebase's hour) is given with its time of day and a request to open the link at once.
 */
export function limitedInviteMessage(fields, limit) {
  if (!limit || !limit.short) return inviteMessage({ ...fields, expiresAt: limit ? limit.at : fields.expiresAt });
  return inviteMessage({ ...fields, expiresAt: null }).replace('The link works once;',
    `The link works once and only until about ${timeText(limit.at)} on ${dateText(limit.at)}, so please open it as soon as this message arrives;`);
}
