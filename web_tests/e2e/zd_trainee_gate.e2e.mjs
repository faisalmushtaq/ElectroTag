// The lock on a trainee's study work (docs/using.md, "The training programme"; docs/admin_area.md, "Annotators"): a
// trainee in a programme does not see study recordings given to them until their training is done (the sandbox's
// set has no assessment, so until the path is finished), the home page says how many wait, and the study team can
// let them through without it. Training recordings never appear among the study recordings. In the demonstration.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'demonstration: a trainee\'s study recordings stay hidden until the study team lets them through',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      const rid = await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        const r = (await b.admin('recordings_list', {})).recordings.find((x) => x.scope === 'study');
        await b.admin('assign', { annotator_ids: ['T01'], recording_ids: [r.recording_id] });
        return r.recording_id;
      });
      await page.evaluate(() => globalThis.ElectroTag.backend.logout());
      await page.reload();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training'), /Your study recordings open once you have finished your training path/);
      await page.click('[data-log="training-back"]');
      await waitForRoute(page, 'home');
      // hidden from the list; the line says how many wait and why
      assert.match(await page.textContent('.next-card'), /1 study recording is waiting for you\. Your study recordings open once you have finished your training path/);
      assert.equal(await page.locator('.recordings-card tr', { hasText: rid.split('/').pop() }).count(), 0);
      await t.screenshot(page, 'trainee_locked_home');
      // the study team lets them through
      await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        await b.logout();
        await b.login('ADMIN', 'demo');
        await b.admin('training_let_through', { annotator_id: 'T01', open: true });
        await b.logout();
      });
      await page.reload();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await page.click('[data-log="training-back"]');
      await waitForRoute(page, 'home');
      await page.locator('.recordings-card tr', { hasText: rid.split('/').pop() }).first().waitFor();
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.me.training_gate.open), true);
    },
  },
];
