import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationOperations } from '../operations.js';
import type { SessionStore, AgentPort, RunPort, SettingsPort } from '../../contracts/services.js';

test('deleting a parent cancels active descendants before awaiting their completion', async () => {
  const cancelled: string[] = [];
  const released: string[] = [];
  const deleted: string[] = [];
  const registry = {
    descendants: (ids: string[]) => ids.includes('parent') ? ['parent', 'child'] : ids,
    get: () => ({ workspaceId: 'workspace' }),
    delete: (ids: string[]) => { deleted.push(...ids); return ['parent','child']; }
  } as unknown as SessionStore;
  const runs = {
    size: 0,
    cancel: (id: string) => { cancelled.push(id); return true; },
    completion: () => undefined
  } as unknown as RunPort;
  const pi = {
    hasPending: false,
    openingSession: () => undefined,
    release: (id: string) => { released.push(id); }
  } as unknown as AgentPort;
  const settings = { changing: false } as SettingsPort;
  const operations = new ConversationOperations(registry, pi, runs, settings);
  assert.deepEqual(await operations.delete(['parent']), ['parent','child']);
  assert.deepEqual(cancelled, ['parent','child']);
  assert.deepEqual(released, ['parent','child']);
  assert.deepEqual(deleted, ['parent']);
});
