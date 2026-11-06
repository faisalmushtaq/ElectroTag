// One person's saved work on one recording, in the admin area's lists of a person's work (Results, Work; and
// Annotators, the person's page): Download gives every saved version's files in one zip, Withdraw takes the
// work out of the study's results until it is restored, and the Withdrawn card lists what was taken out with
// Restore (docs/admin_area.md, "Results"; docs/api.md, "Saved work: download and withdraw").

import { h, clear } from '../ui/dom.js';
import { ask, showDialog } from '../ui/dialog.js';
import { zipBytes } from '../data/zip.js';
import { downloadFiles } from '../views/common.js';
import { card, dataTable, recordingName } from './ui.js';
import { whenText } from './model.js';

/** A recording's file name, for a sentence. */
const fileName = (rid) => String(rid).split('/').pop();

/** What withdrawing does, in plain words (the question before it and the docs). */
export const WITHDRAW_EXPLAINED = 'Every saved version leaves the study\'s results: the lists, the analyses, the results zip and the export. '
  + 'It is kept aside, and Restore puts it back as it was.';

/** The files of every version as one zip: a folder for each version, named after its files. */
export function savedWorkZip(answer) {
  const files = [];
  for (const v of answer.versions || []) for (const f of v.files || []) files.push({ name: `${v.folder}/${f.name}`, text: f.text });
  return { name: answer.file_name, blob: new Blob([zipBytes(files)], { type: 'application/zip' }) };
}

/** What happens to the recording afterwards, as the person chooses it in the question. */
export const THEN_WORDS = { todo: 'given back to annotate again', unassign: 'taken off their list' };

/**
 * Download and Withdraw for a row of a person's work (`item`: recording_id, mode, context_id, status,
 * attempts). `onChange` runs after a withdrawal; `msg` is the card's message area.
 */
export function savedWorkButtons(area, annotatorId, item, { onChange = () => {}, msg = null } = {}) {
  if (!(item.attempts > 0) && item.status !== 'done') return null;
  const body = { annotator_id: annotatorId, recording_id: item.recording_id, mode: item.mode || 'standard', context_id: item.context_id || '' };
  const download = h('button.btn.small', { type: 'button', 'data-log': 'saved-work-download', 'data-recording': item.recording_id,
    title: `Download ${annotatorId}'s saved files of this recording, every version`,
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const answer = await area.read('saved_work_get', body);
        downloadFiles([savedWorkZip(answer)]);
        if (msg) msg.show('success', `${answer.file_name} offered to save (${answer.versions.length === 1 ? 'one version' : `${answer.versions.length} versions`}).`);
      } catch (exc) { if (msg) msg.problem(exc); } finally { b.disabled = false; }
    } }, 'Download');
  if ((item.mode || 'standard') !== 'standard') return h('span.btn-row.tight', {}, download);
  const withdraw = h('button.btn.small', { type: 'button', 'data-log': 'saved-work-withdraw', 'data-recording': item.recording_id,
    title: `Take ${annotatorId}'s saved work on this recording out of the results`,
    onclick: async (e) => {
      const b = e.currentTarget;
      const then = await showDialog({
        title: `Withdraw ${annotatorId}'s work?`,
        body: h('div', {}, h('p.dialog-text', {}, `${annotatorId}'s saved work on ${fileName(item.recording_id)} (${item.attempts === 1 ? 'one version' : `${item.attempts} versions`}) is withdrawn. ${WITHDRAW_EXPLAINED}`),
          h('p.dialog-text', {}, 'What happens to the recording in their list?')),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Take it off their list', value: 'unassign' },
          { label: 'Give it back to annotate again', value: 'todo', kind: 'primary' }],
        className: 'withdraw-question', cancelValue: null,
      });
      if (!then) return;
      b.disabled = true;
      try {
        let out;
        try {
          out = await area.write('saved_work_withdraw', { ...body, then });
        } catch (exc) {
          if (exc.code !== 'downloaded') throw exc;
          const yes = await ask('Already downloaded', `${exc.message}\n\nWithdraw it from the study anyway?`,
            { yes: 'Withdraw anyway', no: 'Keep it', defaultYes: false, destructive: true });
          if (!yes) { if (msg) msg.show('note', 'Nothing was withdrawn.'); return; }
          out = await area.write('saved_work_withdraw', { ...body, then, downloaded_ok: true });
        }
        const w = out.withdrawal;
        if (msg) msg.show('success', `${annotatorId}'s work on ${fileName(w.recording_id)} is withdrawn, and the recording is ${THEN_WORDS[w.then]}. Withdrawn work, below, can restore it.`);
        await onChange();
      } catch (exc) { if (msg) msg.problem(exc); } finally { b.disabled = false; }
    } }, 'Withdraw');
  return h('span.btn-row.tight', {}, download, withdraw);
}

/** The work of one person withdrawn from the results, with Restore; empty while there is none. */
export function withdrawnCard(area, annotatorId, { onChange = () => {}, msg = null } = {}) {
  const host = h('div.withdrawn-work', { 'data-part': 'withdrawn' });
  const show = async () => {
    let rows = [];
    try { rows = (await area.read('withdrawals_list', { annotator_id: annotatorId })).withdrawals || []; } catch (exc) { if (msg) msg.problem(exc); }
    clear(host);
    if (!rows.length) return;
    host.append(card('Withdrawn work',
      h('p.caption', {}, `Saved work of ${annotatorId} taken out of the study's results. Restore puts it back as it was, unless they have saved the recording again since.`),
      dataTable([
        { title: 'Recording', render: (w) => recordingName(w.recording_id) },
        { title: 'Versions', num: true, render: (w) => String((w.versions || []).length) },
        { title: 'Withdrawn', render: (w) => `${whenText(w.withdrawn_at)} by ${w.withdrawn_by}` },
        { title: 'The recording', render: (w) => THEN_WORDS[w.then] || w.then },
        { title: '', cls: 'actions', render: (w) => h('button.btn.small', { type: 'button', 'data-log': 'saved-work-restore', 'data-recording': w.recording_id,
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              await area.write('saved_work_restore', { withdrawal_id: w.withdrawal_id });
              if (msg) msg.show('success', `${annotatorId}'s work on ${fileName(w.recording_id)} is back in the results.`);
              await onChange();
            } catch (exc) { if (msg) msg.problem(exc); b.disabled = false; }
          } }, 'Restore') },
      ], rows, { pageSize: 10 })));
  };
  host.refresh = show;
  show();
  return host;
}
