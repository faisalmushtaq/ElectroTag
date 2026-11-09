// Training recordings given in Assignments beyond a trainee's programme (a guided, practice or assessment mode with
// a reference set): listed on the training path (path.js), or on the home page for someone outside a programme
// (home.js), never among the study recordings, since nothing in them is study work.

import { h } from '../ui/dom.js';

const EXTRA_MODES = { guided: 'Guided', practice: 'Practice', assessment: 'Assessment' };

/**
 * Training recordings given to the trainee in Assignments, beyond their programme's (a guided, practice or assessment
 * mode with another reference set): listed here, never among their study recordings, since nothing in them is
 * study work.
 */
export function extraTraining(app, data = null) {
  const items = ((app && app.assignments && app.assignments.items) || [])
    .filter((i) => (i.mode || 'standard') !== 'standard' && (!data || i.context_id !== data.set_id));
  if (!items.length) return null;
  return h('section.card.extra-training', { 'data-part': 'extra-training' },
    h('h2', {}, data ? 'More training recordings' : 'Training recordings'),
    h('p.caption', {}, 'Given to you by your study team for training. What you mark here is training, not study work.'),
    h('ul', {}, items.map((it) => h('li', {},
      h('span', {}, h('b', {}, it.file_name || it.recording_id), ' ', h('span.caption', {}, `${EXTRA_MODES[it.mode] || it.mode}${it.status === 'done' ? ', done' : ''}`)),
      it.status === 'done' || it.status === 'unusable' ? null
        : h('button.btn.small', { type: 'button', 'data-log': 'extra-training-open', 'aria-label': `Open ${it.file_name}`, onclick: () => app.openAssignment(it) },
          it.status === 'in_progress' ? 'Continue' : 'Open')))));
}
