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

test('scoped priority matching reject invalid registrations', () => {
  const registry = new ContributionRegistry();
  const scope = { workspaceId: 'workspace', sessionId: 'one' };
  registry.register('conversation.chat.node', { owner: 'core', id: 'control', value: 'global' });
  registry.register('conversation.chat.node', { owner: 'custom', id: 'control', scope, priority: 5, value: 'session' });
  assert.equal(registry.resolve('conversation.chat.node', scope)[0].value, 'session');
  assert.equal(registry.resolve('conversation.chat.node', { ...scope, sessionId: 'two' })[0].value, 'global');
  registry.register('conversation.chat.node', { owner: 'core', id: 'fallback', value: 'fallback', priority: 1 });
  registry.register('conversation.chat.node', { owner: 'custom', id: 'special', value: 'special', priority: 2, accepts: (input) => input === 'match' });
  assert.equal(registry.resolve('conversation.chat.node', undefined, undefined, 'other')[0].value, 'fallback');
  assert.equal(registry.resolve('conversation.chat.node', undefined, undefined, 'match')[0].value, 'special');
  assert.throws(() => registry.register('tool.call.toolview', { owner: 'bad', id: 'bad', value: null }), /requires a key/);
  assert.throws(() => registry.register('conversation.chat.node', { owner: 'core', id: 'control', value: null }), /Duplicate/);
  assert.throws(() => registry.register('conversation.chat.node', { owner: 'bad', id: 'bad', scope: { workspaceId: '' }, value: null }), /scope/);
});

test('a failing observer leaves registration committed and other observers in sync', () => {
  const errors: Error[] = [];
  const registry = new ContributionRegistry((error) => errors.push(error));
  const region = 'conversation.input.dock';
  const before: unknown[] = [], after: unknown[] = [];
  const read = () => registry.resolve(region).map(({ value }) => value);
  registry.watch(() => before.push(read()));
  const failure = new Error('render failed');
  registry.watch(() => { throw failure; });
  registry.watch(() => after.push(read()));

  const dispose = registry.register(region, { owner: 'plugin', id: 'widget', value: 'active' });
  assert.deepEqual(read(), ['active']);
  dispose();
  dispose();
  assert.deepEqual(before, [['active'], []]);
  assert.deepEqual(after, before);
  assert.deepEqual(read(), []);
  assert.deepEqual(errors, [failure, failure]);
});
