// One person's saved work in the sandbox's admin area (js/api/demo_library.js, the Withdrawals part, and
// js/admin/saved_work.js): every version's files to download, withdrawing it with the recording given back or
// taken off the list, and restoring it. The server's answers to the same calls are compared by
// api_contract_parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { EXAMPLE_ANSWERS } from '../../electrotag/web/static/js/api/demo_questionnaire.js';
import { savedWorkZip } from '../../electrotag/web/static/js/admin/saved_work.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

async function as(b, id) {
  await b.logout();
  await b.login(id, 'demo');
  return b;
}

/** A01 saves their first recording twice (a revision), and ADMIN signs in. */
async function savedTwice() {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  await b.admin('settings_update', { settings: { annotation: { allow_revisions: true } } });
  await as(b, 'A01');
  try { await b.saveQuestionnaire({ answers: EXAMPLE_ANSWERS, contacts: { full_name: 'Test person', email: 'test@example.org' } }); } catch { /* answered */ }
  const rid = (await b.assignments()).items[0].recording_id;
  const sha = (await b.exampleRecording(rid).fingerprint()).hex;
  const save = (revises) => b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: [], session: { elapsed_s: 5 }, sha256: sha, ...(revises ? { revises } : {}) });
  await save();
  await save(1);
  await as(b, 'ADMIN');
  return { b, rid };
}

const statusOf = async (b, rid) => ((await b.admin('assignments_list', { annotator_id: 'A01' })).items.find((i) => i.recording_id === rid) || {}).status;

test('every saved version is downloaded in one zip, a folder for each', async () => {
  const { b, rid } = await savedTwice();
  const out = await b.admin('saved_work_get', { annotator_id: 'a01', recording_id: rid });
  assert.deepEqual(out.versions.map((v) => v.version), [1, 2]);
  assert.match(out.file_name, /_A01_saved\.zip$/);
  assert.ok(out.versions.every((v) => v.files.some((f) => f.name.endsWith('_annotations.json'))));
  assert.match(out.versions[1].folder, /_attempt-02$/);
  const zip = savedWorkZip(out);
  assert.equal(zip.name, out.file_name);
  const bytes = new Uint8Array(await zip.blob.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes(`${out.versions[1].folder}/`), 'each version in its own folder');
  await assert.rejects(() => b.admin('saved_work_get', { annotator_id: 'A02', recording_id: rid }), (e) => e.status === 404 && e.code === 'not_saved');
});

test('withdrawn work leaves the results and comes back as it was', async () => {
  const { b, rid } = await savedTwice();
  assert.equal(await statusOf(b, rid), 'done');
  await assert.rejects(() => b.admin('saved_work_withdraw', { annotator_id: 'A01', recording_id: rid, then: 'later' }), (e) => e.code === 'bad_request');
  const w = (await b.admin('saved_work_withdraw', { annotator_id: 'A01', recording_id: rid, then: 'todo' })).withdrawal;
  assert.deepEqual(w.versions.map((v) => v.version), [1, 2]);
  assert.equal(await statusOf(b, rid), 'todo', 'given back to annotate again');
  await assert.rejects(() => b.admin('saved_work_get', { annotator_id: 'A01', recording_id: rid }), (e) => e.code === 'not_saved');
  assert.deepEqual((await b.admin('withdrawals_list', { annotator_id: 'A01' })).withdrawals.map((x) => x.withdrawal_id), [w.withdrawal_id]);
  const audit = (await b.admin('audit', { limit: 1 })).entries[0];
  assert.equal(audit.op, 'saved_work_withdraw');
  assert.match(audit.summary, /2 versions\); the recording was given back to annotate again$/);
  await b.admin('saved_work_restore', { withdrawal_id: w.withdrawal_id });
  assert.equal(await statusOf(b, rid), 'done');
  assert.equal((await b.admin('saved_work_get', { annotator_id: 'A01', recording_id: rid })).versions.length, 2);
  assert.deepEqual((await b.admin('withdrawals_list', {})).withdrawals, []);
  await assert.rejects(() => b.admin('saved_work_restore', { withdrawal_id: w.withdrawal_id }), (e) => e.status === 404 && e.code === 'no_withdrawal');
});

test('taken off the list, and back on it when restored', async () => {
  const { b, rid } = await savedTwice();
  const w = (await b.admin('saved_work_withdraw', { annotator_id: 'A01', recording_id: rid, then: 'unassign' })).withdrawal;
  assert.equal(await statusOf(b, rid), undefined);
  await b.admin('saved_work_restore', { withdrawal_id: w.withdrawal_id });
  assert.equal(await statusOf(b, rid), 'done');
});

test('work saved again keeps the withdrawn work aside, and training work stays', async () => {
  const { b, rid } = await savedTwice();
  const w = (await b.admin('saved_work_withdraw', { annotator_id: 'A01', recording_id: rid, then: 'todo' })).withdrawal;
  await as(b, 'A01');
  const sha = (await b.exampleRecording(rid).fingerprint()).hex;
  await b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: [], session: { elapsed_s: 5 }, sha256: sha });
  await as(b, 'ADMIN');
  await assert.rejects(() => b.admin('saved_work_restore', { withdrawal_id: w.withdrawal_id }), (e) => e.status === 409 && e.code === 'saved_again');
  await assert.rejects(() => b.admin('saved_work_withdraw', { annotator_id: 'T01', recording_id: rid, mode: 'practice', context_id: 'example', then: 'todo' }),
    (e) => e.code === 'not_study_work');
});
