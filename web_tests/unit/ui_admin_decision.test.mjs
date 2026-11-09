// The study team's decision on an assessment (js/admin/assessment_decision.js): where it fell short, for the
// conversation after Fail, and the decision in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decisionText, weakAreas } from '../../electrotag/web/static/js/admin/assessment_decision.js';

test('the areas of weakness: the criteria not met first, then the artifact types with the lowest scores', () => {
  const report = {
    checks: [{ criterion: 'event F1 >= 0.80', where: 'overall', value: 0.62, passed: false }, { criterion: 'kappa >= 0.6', where: 'overall', value: 0.7, passed: true }],
    metrics: { per_category: [
      { category: 'Eye-blink-artifact', reference_events: 6, event_f1: 0.9, sensitivity: 0.9 },
      { category: 'EMG-artifact', reference_events: 4, event_f1: 0.4, sensitivity: 0.5 },
      { category: 'Chewing-artifact', reference_events: 0, event_f1: 0, sensitivity: 0 },
      { category: 'Movement-artifact', reference_events: 2, event_f1: 0.55, sensitivity: null },
    ] },
  };
  assert.deepEqual(weakAreas(report), [
    'event F1 >= 0.80 (overall: 0.62)',
    "EMG-artifact: score 0.40, found 50% of the experts' 4",
    'Movement-artifact: score 0.55',
  ]);
  assert.deepEqual(weakAreas({}), []);
  assert.equal(weakAreas(report, 1).length, 1);
});

test('a decision in words, with what its criteria said', () => {
  assert.equal(decisionText({ decision: null }), '');
  assert.match(decisionText({ decision: { result: 'met', by: 'ADMIN', at: null, criteria: 'not_determined' } }),
    /^Passed by ADMIN, never \(its criteria gave no result/);
  assert.match(decisionText({ decision: { result: 'not_met', by: 'E01', at: null, criteria: 'met' } }), /^Not passed by E01, .*its criteria met the competency criteria\)\.$/);
});
