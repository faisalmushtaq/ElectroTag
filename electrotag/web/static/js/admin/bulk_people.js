// The people of "Add several" (docs/admin_area.md, "Adding several people"): pasted lines or a CSV file, one
// person a line with their annotator ID, name, email address and roles. Every line is checked before any
// account is made. A part of the admin area, loaded with Annotators, so that the sign-in page stays within its
// budget of JavaScript.

import { checkAnnotatorId, checkEmail, ROLES } from './model.js';

/** The columns, in the order they are read when the list has no line of column names. */
export const COLUMNS = Object.freeze(['annotator_id', 'display_name', 'email', 'roles']);

/** The column names ElectroTag recognises in a first line (lower case, spaces and dashes as underscores). */
const HEADERS = Object.freeze({
  id: 'annotator_id', annotator_id: 'annotator_id', annotator: 'annotator_id', annotatorid: 'annotator_id',
  name: 'display_name', display_name: 'display_name', full_name: 'display_name',
  email: 'email', e_mail: 'email', email_address: 'email', mail: 'email',
  role: 'roles', roles: 'roles',
});

/** The words a roles cell may use for each role. */
const ROLE_WORDS = Object.freeze({
  annotator: 'annotator', annotators: 'annotator', expert: 'expert', experts: 'expert',
  admin: 'admin', administrator: 'admin', administrators: 'admin', admins: 'admin',
});

/** The largest file read as a list of people, in bytes (200 people take a few kilobytes). */
export const MAX_FILE_BYTES = 200 * 1024;

/**
 * The cells of one line: separated by tabs when it has any, otherwise by commas (outside double quotes),
 * otherwise by semicolons, as spreadsheets save CSV in different countries. Double quotes around a cell
 * keep its commas, and "" inside them is one quotation mark.
 */
export function splitLine(raw) {
  const sep = raw.includes('\t') ? '\t' : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(raw) ? ',' : raw.includes(';') ? ';' : ',';
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell.trim()) {
      quoted = true;
      cell = '';
    } else if (c === sep) {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const headerKey = (cell) => HEADERS[String(cell).toLowerCase().trim().replace(/[\s-]+/g, '_')] || null;

/** The roles of a cell ("expert", "annotator; expert", "Annotator + Administrator"), or a problem in words. */
export function rolesOfCell(text) {
  const words = String(text || '').toLowerCase().split(/[\s,;|/+&]+|\band\b/).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w === 'participant' || w === 'participants') return { problem: 'the participant role cannot be given yet' };
    const role = ROLE_WORDS[w];
    if (!role) return { problem: `"${w}" is not a role; the roles are ${Object.values(ROLES).join(', ').toLowerCase()}` };
    out.add(role);
  }
  return { roles: ['admin', 'expert', 'annotator'].filter((r) => out.has(r)) };
}

/**
 * The people of the list `text`. Each line holds an ID, then a name, an email address and roles, separated by
 * commas, semicolons or tabs; a first line of column names (ID, name, email, roles, in any order) is read
 * as such. `roles` are given to anyone without roles of their own. Returns {rows, problems}: the accounts to
 * make, [{line, annotator_id, display_name, email, roles}], and the lines to correct, [{line, text}].
 */
export function parseBulkPeople(text, { existing = [], emailRequired = false, max = 200, roles = ['annotator'] } = {}) {
  const taken = new Set(existing.map((x) => String(x).toUpperCase()));
  const rows = [];
  const problems = [];
  const ids = new Map();
  const emails = new Map();
  let columns = COLUMNS;
  let first = true;
  String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const parts = splitLine(raw);
    if (first) {
      first = false;
      const keys = parts.map(headerKey);
      if (keys[0] && keys.filter(Boolean).length >= 1 && !/\d/.test(parts[0])) { // column names
        const unknown = parts.filter((p, j) => p && !keys[j]);
        if (unknown.length) {
          problems.push({ line, text: `Line ${line}: ElectroTag does not read the column "${unknown[0]}"; the columns are ID, name, email and roles.` });
          return;
        }
        if (new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length) {
          problems.push({ line, text: `Line ${line} names a column twice.` });
          return;
        }
        if (!keys.includes('annotator_id')) {
          problems.push({ line, text: `Line ${line} has no column for the annotator ID.` });
          return;
        }
        columns = keys;
        return;
      }
    }
    if (parts.length > columns.length && parts.slice(columns.length).some(Boolean)) {
      problems.push({ line, text: `Line ${line} has more than ${columns.length} parts; give the ID, the name, the email address and the roles.` });
      return;
    }
    const cell = (key) => (columns.indexOf(key) >= 0 ? parts[columns.indexOf(key)] || '' : '');
    let id;
    let email;
    try { id = checkAnnotatorId(cell('annotator_id')); } catch (exc) { problems.push({ line, text: `Line ${line}: ${exc.message}` }); return; }
    try { email = checkEmail(cell('email'), { required: emailRequired }); } catch (exc) { problems.push({ line, text: `Line ${line} (${id}): ${exc.message}` }); return; }
    const name = cell('display_name');
    const given = cell('roles').trim() ? rolesOfCell(cell('roles')) : { roles: [...roles] };
    if (given.problem) { problems.push({ line, text: `Line ${line} (${id}): ${given.problem}.` }); return; }
    if (!given.roles.length) { problems.push({ line, text: `Line ${line} (${id}): choose at least one role.` }); return; }
    if (taken.has(id)) { problems.push({ line, text: `Line ${line}: ${id} already has an account in this study.` }); return; }
    if (ids.has(id)) { problems.push({ line, text: `Line ${line}: ${id} is also on line ${ids.get(id)}.` }); return; }
    if (email && emails.has(email.toLowerCase())) { problems.push({ line, text: `Line ${line}: ${email} is also on line ${emails.get(email.toLowerCase())}.` }); return; }
    if (name.length > 200) { problems.push({ line, text: `Line ${line}: the name has more than 200 characters.` }); return; }
    ids.set(id, line);
    if (email) emails.set(email.toLowerCase(), line);
    rows.push({ line, annotator_id: id, display_name: name, email, roles: given.roles });
  });
  if (rows.length + problems.length > max) problems.unshift({ line: 0, text: `At most ${max} people can be added at once; split the list.` });
  if (!rows.length && !problems.length) problems.push({ line: 0, text: 'Give one line for each person: their ID, then their name, email address and roles, separated by commas.' });
  return { rows, problems };
}

/** The text of a file chosen as the list of people, or a problem in plain words. */
export async function readPeopleFile(file) {
  if (!file) return { problem: 'Choose a file first.' };
  if (file.size > MAX_FILE_BYTES) return { problem: `${file.name} is larger than a list of people would be (${Math.round(file.size / 1024)} KB); choose a CSV file of the people to add.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { text: new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes).replace(/^﻿/, '') };
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { problem: `${file.name} is a spreadsheet file; save it as CSV (comma-separated values) and choose that file.` };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '') };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes) }; // an older spreadsheet's own encoding
  }
}

/** Whether a person is given a private invitation link: administrators get a temporary password instead. */
export const invited = (row) => !row.roles.includes('admin');
