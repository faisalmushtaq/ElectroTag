// The study team's decision on a trainee's competency assessment (docs/admin_area.md, "Deciding an assessment"):
// under the competency report in Analyses, Pass or Fail, whatever its criteria said, with each assessment
// recording to look at in the EEG viewer beside the reference first; Fail asks the administrator to go through
// the areas of weakness with the trainee before they try again. The Overview lists the assessments waiting for a
// decision (waitingCard). Each decision is sent once and kept in the audit log (assessment_decide).
//
// weakAreas and decisionText are pure and tested in Node (web_tests/unit/ui_admin_decision.test.mjs).

import { h, clear } from '../ui/dom.js';
import { actionButton, card, chip, confirmInline, messageArea } from './ui.js';
import { whenText } from './model.js';
import { startAssessmentReview } from '../views/purposes.js';

export const CRITERIA_WORDS = { met: 'met the competency criteria', not_met: 'did not meet the competency criteria',
  not_determined: 'gave no result (no criteria decide it, or some could not be judged)' };

/** Where an assessment fell short, from the competency report, for the conversation after Fail: at most `n` lines. */
export function weakAreas(report, n = 5) {
  const out = [];
  for (const c of (report && report.checks) || []) {
    if (c.passed === false) out.push(`${c.criterion} (${c.where}${Number.isFinite(c.value) ? `: ${Number(c.value).toFixed(2)}` : ''})`);
  }
  const cats = (((report && report.metrics) || {}).per_category || [])
    .filter((c) => Number(c.reference_events) > 0 && Number.isFinite(Number(c.event_f1)))
    .sort((a, b) => Number(a.event_f1) - Number(b.event_f1));
  for (const c of cats) {
    if (out.length >= n || Number(c.event_f1) >= 0.8) break;
    const found = c.sensitivity !== null && c.sensitivity !== undefined && Number.isFinite(Number(c.sensitivity)) ? `, found ${Math.round(Number(c.sensitivity) * 100)}% of the experts' ${c.reference_events}` : '';
    out.push(`${c.category}: score ${Number(c.event_f1).toFixed(2)}${found}`);
  }
  return out.slice(0, n);
}

/** The decision as it stands, in words: "Passed by ADMIN on 9 November (the criteria said: not determined)". */
export function decisionText(g) {
  const d = g && g.decision;
  if (!d) return '';
  const criteria = d.criteria ? ` (its criteria ${CRITERIA_WORDS[d.criteria] || d.criteria})` : '';
  return `${d.result === 'met' ? 'Passed' : 'Not passed'} by ${d.by || 'the study team'}, ${whenText(d.at)}${criteria}.`;
}

/**
 * The decision under a competency report: what the criteria said, the decision if one was made, Pass and Fail,
 * and the assessment recordings to look at in the viewer. `g` is training_gate_get's answer; `report` the
 * competency report (for the areas of weakness); `onChanged(g)` after a decision.
 */
export function decisionBlock(area, aid, g, report, { onChanged = null } = {}) {
  const host = h('section.card.admin-card.decision-card', { 'data-part': 'assessment-decision' });
  const draw = (gate) => {
    clear(host);
    const msg = messageArea();
    host.append(h('h2', {}, `Decide ${aid}'s assessment`));
    if (!gate.can_decide) {
      host.append(h('p.caption', {}, `${aid} has not finished the assessment of their training programme yet: the decision comes once every assessment recording is saved.`));
      return;
    }
    const open = gate.training_gate && gate.training_gate.open;
    host.append(h('p', {}, gate.criteria ? `Its criteria: ${aid}'s assessment ${CRITERIA_WORDS[gate.criteria] || gate.criteria}. ` : '',
      gate.decision ? h('b', {}, decisionText(gate)) : 'Nobody has decided it yet.', ' ',
      open ? chip('Study recordings open', 'done') : chip('Study recordings locked', 'warning')));
    const attempts = gate.attempts || [];
    if (attempts.length) {
      host.append(h('p.caption', {}, `Before deciding, look at ${aid}'s marks beside the reference on each recording, as a practice review shows them: open the recording from this computer.`),
        h('ul.decision-attempts', {}, attempts.map((a) => h('li', {}, h('span', {}, a.file_name),
          h('button.btn.small', { type: 'button', 'data-log': 'assessment-review', onclick: () => startAssessmentReview(area.app, {
            annotator_id: aid, recording_id: a.recording_id,
            back: { route: 'admin-analyses', params: { competency: (gate.programme && gate.programme.set_id) || '', annotator: aid, decide: true } } }) },
          'Look at it in the viewer')))));
    }
    const buttons = h('div.btn-row');
    const decide = async (result) => {
      const pass = result === 'met';
      const text = pass ? `Pass ${aid}'s assessment? Their study recordings open.`
        : `Not pass ${aid}'s assessment? Their study recordings stay locked until you reopen their training or give them a new assessment.`;
      if (!(await confirmInline(buttons, { text, yes: pass ? 'Pass' : 'Not passed', destructive: !pass }))) return;
      const next = await area.write('assessment_decide', { annotator_id: aid, result });
      draw(next);
      if (pass) msg.show('success', `${aid}'s assessment is passed: their study recordings are open.`);
      else {
        const weak = weakAreas(report);
        msg.show('success', `${aid}'s assessment is not passed.`,
          h('p', {}, `Before ${aid} tries again, go through the areas of weakness with them, so that they know what to work on`,
            weak.length ? ':' : ': the competency report above shows each measure and each artifact type.'),
          weak.length ? h('ul', {}, weak.map((w) => h('li', {}, w))) : null,
          h('p', {}, 'Then reopen their training for more practice, or give them a new assessment, on their page.'),
          h('div.btn-row', {}, h('button.btn.small', { type: 'button', 'data-log': 'decision-to-person', onclick: () => area.go('annotators', { annotator: aid }) },
            `Go to ${aid}'s page`)));
      }
      if (onChanged) onChanged(next);
    };
    const pass = actionButton('Pass', { kind: 'primary', working: 'Saving…', msg, log: 'assessment-pass', onClick: () => decide('met') });
    const fail = actionButton('Fail', { working: 'Saving…', msg, log: 'assessment-fail', onClick: () => decide('not_met') });
    if (gate.decision) (gate.decision.result === 'met' ? pass : fail).disabled = true;
    buttons.append(pass, fail);
    host.append(buttons, msg);
  };
  draw(g);
  return host;
}

/** The Overview's alert: finished assessments that wait for the study team, each with a way to its competency report. */
export function waitingCard(area, waiting) {
  const list = (waiting && waiting.assessments) || [];
  if (!list.length) return null;
  return card(`${list.length === 1 ? 'An assessment waits' : `${list.length} assessments wait`} for your decision`,
    h('p.caption', {}, 'These trainees have finished the competency assessment and their criteria did not pass it. Look at the report and their attempt, then pass or fail it.'),
    h('ul.waiting-list', {}, list.map((a) => h('li', { 'data-annotator': a.annotator_id },
      h('span', {}, h('b', {}, a.annotator_id), ` · ${a.set_name}: its criteria ${CRITERIA_WORDS[a.criteria] || a.criteria}`),
      h('button.btn.small', { type: 'button', 'data-log': 'waiting-report', onclick: () => area.go('analyses', { competency: a.set_id, annotator: a.annotator_id, decide: true }) },
        'See the competency report')))));
}
