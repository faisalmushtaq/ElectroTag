// What the views of looking for training recordings share, without the page, so that it can be tested in Node:
// the expert's ratings and requests in words, the filters of a dataset's recordings, which recordings can still be
// asked for, and the coverage of the artifact types that need training material (docs/admin_area.md, "Looking for
// training recordings"; the operations in docs/api.md, "Looking for training recordings").

/** The ratings an expert gives a recording for training, in the order of their buttons. */
export const RATINGS = Object.freeze([['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']]);
export const RATING_WORDS = Object.freeze({ yes: 'Yes', maybe: 'Maybe', no: 'No' });
/** A request's status, in words, and the chip kind it is shown with. */
export const STATUS_WORDS = Object.freeze({
  pending: ['Asked for', 'active'], approved: ['Approved', 'done'], declined: ['Declined', 'warning'],
  withdrawn: ['Taken back', ''], removed: ['Taken off the list', ''],
});
/** Requests that can be made again: none yet, or one declined, taken back or taken off a set's list. */
const CLOSED = new Set(['declined', 'withdrawn', 'removed']);
/** The filters of a dataset's recordings. */
export const BROWSE_FILTERS = Object.freeze([['', 'Every recording'], ['unrated', 'Not rated yet'], ['yes', 'Rated Yes'],
  ['maybe', 'Rated Maybe'], ['no', 'Rated No'], ['asked', 'Asked for'], ['notes', 'With a note']]);
/** The longest note an expert may keep on a recording (electrotag/web/candidates.py MAX_NOTE). */
export const MAX_NOTE = 5000;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A request in words for the expert who made it ('' when there is none). */
export function requestText(r) {
  if (!r) return '';
  if (r.status === 'pending') return 'Asked for: waiting for the study team';
  if (r.status === 'approved') return `Approved into ${r.set_name || r.set_id}, awaiting annotation`;
  if (r.status === 'declined') return `Declined${r.reason ? `: ${r.reason}` : ''}. You can ask again.`;
  if (r.status === 'withdrawn') return 'You took the request back. You can ask again.';
  if (r.status === 'removed') return 'Taken off the training set\'s list. You can ask again.';
  return '';
}

/** True when the recording can be asked for now. */
export function canAsk(row) {
  const r = row && row.request;
  return !r || CLOSED.has(r.status);
}

/** The recordings of a dataset that one filter keeps. */
export function filterRows(rows, filter) {
  const all = rows || [];
  if (!filter) return all;
  if (filter === 'unrated') return all.filter((r) => !r.rating);
  if (filter === 'asked') return all.filter((r) => r.request && !CLOSED.has(r.request.status));
  if (filter === 'notes') return all.filter((r) => r.has_note);
  return all.filter((r) => r.rating === filter);
}

/** Of the recordings chosen, those that can be asked for, and the words of the button that asks for them. */
export function askable(rows) {
  const can = (rows || []).filter(canAsk);
  return { rows: can, label: can.length ? `Ask for ${plural(can.length, 'recording')} to be added to training` : 'Ask for the chosen recordings' };
}

/** The marks an expert made on a recording while looking, in words ("3 marks: 2 Eye-blink-artifact, 1 EMG-artifact"). */
export function marksText(n, labels) {
  if (!n) return 'No marks';
  const parts = Object.entries(labels || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, k]) => `${k} ${l}`);
  return `${plural(n, 'mark')}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** The artifact types that need training material: those the study chose, or the types on its number keys. */
export function requiredTypes(settings) {
  const s = settings || {};
  const chosen = (s.training || {}).required_types;
  return Array.isArray(chosen) ? [...chosen] : [...(((s.annotation || {}).quick_labels) || [])];
}

/**
 * How far the training sets cover each type that needs training material: `sets` is the answer of
 * training_types_get (each set's reference marks and quiz answers by type). One row a type, in the order given:
 * {label, marks, quiz, sets: [names of the sets with marks of it], missing}.
 */
export function coverageRows(types, sets) {
  return (types || []).map((label) => {
    let marks = 0;
    let quiz = 0;
    const named = [];
    for (const s of sets || []) {
      const m = Number((s.marks || {})[label] || 0);
      const q = Number((s.quiz || {})[label] || 0);
      marks += m;
      quiz += q;
      if (m) named.push(s.name || s.set_id);
    }
    return { label, marks, quiz, sets: named, missing: marks === 0 };
  });
}

/** One line on the coverage of the types that need training material. */
export function coverageSummary(rows) {
  const missing = rows.filter((r) => r.missing);
  if (!rows.length) return 'No artifact types are chosen as needing training material. Choose them in Study settings, under Training policy.';
  if (!missing.length) return `Every one of the ${plural(rows.length, 'artifact type')} that need training material has examples in a training set.`;
  return `${missing.length} of the ${plural(rows.length, 'artifact type')} that need training material ${missing.length === 1 ? 'has' : 'have'} no examples in any training set yet: `
    + `${missing.map((r) => r.label).join(', ')}.`;
}
