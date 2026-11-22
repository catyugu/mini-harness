import test from 'node:test';
import assert from 'node:assert/strict';
import { ContributionRegistry } from '../web/contributions.js';

test('keyed overrides restore the original and list replacements retain their dock position', () => {
  const registry = new ContributionRegistry();
  registry.register('tool.call.toolview', { owner: 'files', id: 'read', key: 'read', value: 'builtin' });
  const dispose = registry.register('tool.call.toolview', { owner: 'custom', id: 'read', key: 'read', priority: 10, value: 'custom' });
  assert.equal(registry.resolve('tool.call.toolview', undefined, 'read')[0].value, 'custom');
  dispose(); dispose();
  assert.equal(registry.resolve('tool.call.toolview', undefined, 'read')[0].value, 'builtin');
  registry.register('conversation.composer.dock', { owner: 'core', id: 'usage', order: 10, value: 'usage' });
  registry.register('conversation.composer.dock', { owner: 'core', id: 'activity', order: 0, value: 'activity' });
  registry.register('conversation.composer.dock', { owner: 'custom', id: 'usage', order: -100, priority: 1, value: 'replacement' });
  assert.deepEqual(registry.resolve('conversation.composer.dock').map(({ value }) => value), ['activity', 'replacement']);
});

test('scope, single, and conditional chain selection reject invalid registrations', () => {
  const registry = new ContributionRegistry();
  const scope = { workspaceId: 'workspace', sessionId: 'one' };
  registry.register('conversation.input.permission', { owner: 'core', id: 'permission', value: 'global' });
  registry.register('conversation.input.permission', { owner: 'custom', id: 'permission', scope, priority: 5, value: 'session' });
  assert.equal(registry.resolve('conversation.input.permission', scope)[0].value, 'session');
  assert.equal(registry.resolve('conversation.input.permission', { ...scope, sessionId: 'two' })[0].value, 'global');
  registry.register('conversation.chat.node', { owner: 'core', id: 'fallback', value: 'fallback' });
  registry.register('conversation.chat.node', { owner: 'custom', id: 'special', value: 'special', priority: 1, accepts: (input) => input === 'match' });
  assert.equal(registry.resolve('conversation.chat.node', undefined, undefined, 'other')[0].value, 'fallback');
  assert.equal(registry.resolve('conversation.chat.node', undefined, undefined, 'match')[0].value, 'special');
  assert.throws(() => registry.register('tool.call.toolview', { owner: 'bad', id: 'bad', value: null }), /requires a key/);
  assert.throws(() => registry.register('conversation.input.permission', { owner: 'core', id: 'permission', value: null }), /Duplicate/);
  assert.throws(() => registry.register('conversation.input.permission', { owner: 'bad', id: 'bad', scope: { workspaceId: '' }, value: null }), /scope/);
});
