// Which backend the application chooses (js/api/choose.js), with a stand-in fetch and address.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { findBackend } from '../../electrotag/web/static/js/api/choose.js';

const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

/** Answers `files` ({url: object}) with JSON and anything else with 404; records the URLs asked for. */
function serve(files, search = '') {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = files[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
    return { ok: true, status: 200, json: async () => body };
  };
  // A page opened from a file: no same-site study server is looked for.
  Object.defineProperty(globalThis, 'location', { value: { search, protocol: 'file:', href: 'file:///index.html' }, configurable: true });
  return asked;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realLocation) Object.defineProperty(globalThis, 'location', realLocation);
  else delete globalThis.location;
});

const WEB = { apiKey: 'key', authDomain: 'my-eeg-study.firebaseapp.com', projectId: 'my-eeg-study', appId: '1:2:web:3' };

test('config.json beside the application names the Firebase project and its study', async () => {
  const asked = serve({ 'config.json': { firebase: WEB, study: 'pilot', functions_region: 'europe-west2' } });
  const where = await findBackend();
  assert.equal(where.kind, 'firebase');
  assert.equal(where.source, 'config');
  assert.equal(where.study, 'pilot');
  assert.deepEqual(where.config, WEB);
  assert.deepEqual(asked, ['config.json'], 'Firebase Hosting\'s settings are not asked for when config.json exists');
});

test('on Firebase Hosting, without config.json, the project\'s own settings and ?study= are used', async () => {
  const asked = serve({ '/__/firebase/init.json': { ...WEB, storageBucket: 'b', messagingSenderId: '4' } }, '?study=pilot');
  const where = await findBackend();
  assert.equal(where.kind, 'firebase');
  assert.equal(where.source, 'hosting');
  assert.equal(where.study, 'pilot');
  assert.equal(where.config.projectId, 'my-eeg-study');
  assert.equal(where.region, 'europe-west2');
  assert.equal(where.emulators, null);
  assert.deepEqual(asked, ['config.json', '/__/firebase/init.json']);
});

test('on Firebase Hosting a link without ?study= leaves the study to the account', async () => {
  serve({ '/__/firebase/init.json': WEB });
  const where = await findBackend();
  assert.equal(where.kind, 'firebase');
  assert.equal(where.study, '');
});

test('an answer at the Hosting address that is not a project\'s settings is passed over', async () => {
  serve({ '/__/firebase/init.json': { hello: 'world' } });
  assert.equal((await findBackend()).kind, 'demo');
});

test('with neither config.json nor Firebase Hosting, the demonstration starts', async () => {
  const asked = serve({});
  const where = await findBackend();
  assert.equal(where.kind, 'demo');
  assert.deepEqual(asked, ['config.json', '/__/firebase/init.json']);
});
