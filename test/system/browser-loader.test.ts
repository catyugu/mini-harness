import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserGraphLoader } from '@mini-harness/ui-runtime/plugin-loader';
import type { FrontendHost } from '@mini-harness/ui-runtime/frontend';

const browser = 'data:text/javascript,' + encodeURIComponent('export default () => {}');
const preload = (version: string) => 'data:text/javascript,' + encodeURIComponent(
  "export default () => { globalThis.__miniLoaderEvents.push('preload:" + version + "'); return () => globalThis.__miniLoaderEvents.push('dispose:" + version + "'); }"
);

test('changing only a browser preload remounts its consumer after disposal', async (t) => {
  const calls: string[] = [];
  (globalThis as unknown as { __miniLoaderEvents: string[] }).__miniLoaderEvents = calls;
  t.after(() => { delete (globalThis as { __miniLoaderEvents?: string[] }).__miniLoaderEvents; });
  const host = {
    async mount(id: string) { calls.push('mount:' + id); },
    async disable(id: string) { calls.push('disable:' + id); }
  } as unknown as FrontendHost;
  const sync = createBrowserGraphLoader(host);
  const snapshot = (version: string) => ({ ui: [{ id: 'example', browser, preload: preload(version), config: {} }] });
  await sync(snapshot('one'));
  assert.deepEqual(calls, ['preload:one', 'mount:example']);
  calls.length = 0;
  await sync(snapshot('two'));
  assert.deepEqual(calls, ['disable:example', 'dispose:one', 'preload:two', 'mount:example']);
  calls.length = 0;
  await sync(snapshot('two'));
  assert.deepEqual(calls, []);
});
