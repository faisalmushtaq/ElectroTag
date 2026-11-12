// The browser's own append, prepend, before, after and replaceChildren write null and undefined as the
// words "null" and "undefined" (the app's h() leaves them out). This finds a call to one of them given
// an item that can be null (`cond ? el : null`) directly, which once showed "null" under the artifact
// type descriptions in the admin area; spread a list instead: ...(cond ? [el] : []).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electrotag', 'web', 'static', 'js');
const CALL = /\.(append|prepend|before|after|replaceChildren)\(/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name))
    : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

/** The arguments of the call whose "(" is at `open`, as text, split at its own commas only. */
export function topArguments(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) { args.push(src.slice(start, i)); return args; }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return args;
}

/** Whether an argument is a choice whose other side is null or undefined, at its own level. */
export function mayBeNull(arg) {
  const a = arg.replace(/\/\/[^\n]*/g, '').trim();
  return /\?[\s\S]*:\s*(null|undefined)$/.test(a) && !a.startsWith('...');
}

test('the check finds a direct null and leaves nested and spread ones alone', () => {
  const src = "x.append(a, c ? h('p') : null, msg); y.append(h('div', {}, c ? b : null)); z.append(...(c ? [b] : []));";
  const found = [...src.matchAll(CALL)].map((m) => topArguments(src, m.index + m[0].length - 1).some(mayBeNull));
  assert.deepEqual(found, [true, false, false]);
});

test('no call of the browser\'s append and its kin is given an item that can be null', () => {
  const problems = [];
  for (const file of files(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      if (topArguments(src, m.index + m[0].length - 1).some(mayBeNull)) {
        problems.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(problems, [], `these would show the word "null": ${problems.join(', ')}`);
});
