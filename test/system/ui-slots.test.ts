import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotRegistry } from '../../packages/ui-slots/registry.js';

class ElementStub {
  children: ElementStub[] = [];
  parent?: ElementStub;
  get childElementCount() { return this.children.length; }
  replaceChildren(...nodes: ElementStub[]) {
    for (const child of this.children) child.parent = undefined;
    this.children = nodes;
    for (const child of nodes) child.parent = this;
  }
  remove() {
    const parent = this.parent;
    if (parent) parent.children = parent.children.filter((node) => node !== this);
    this.parent = undefined;
  }
}
const element = () => new ElementStub();
const node = (item: ElementStub) => item as unknown as HTMLElement;

test('slot contributions can precede their owner and survive remount', () => {
  const registry = new SlotRegistry();
  const alpha = element(), beta = element();
  const removeAlpha = registry.register('sidebar.actions', node(alpha), 20);
  const removeBeta = registry.register('sidebar.actions', node(beta), 5);
  const first = element();
  const stopFirst = registry.define('sidebar.actions', node(first));
  assert.deepEqual(first.children, [beta, alpha]);
  stopFirst();
  assert.deepEqual(first.children, []);
  const next = element();
  const stopNext = registry.define('sidebar.actions', node(next));
  assert.deepEqual(next.children, [beta, alpha]);
  removeBeta();
  assert.deepEqual(next.children, [alpha]);
  removeAlpha();
  assert.deepEqual(next.children, []);
  stopNext();
});

test('owners and contributions have unique identities', () => {
  const registry = new SlotRegistry();
  const owner = element();
  const close = registry.define('conversation.body', node(owner), 'single');
  assert.throws(() => registry.define('conversation.body', node(element())), /Duplicate slot owner/);
  const child = element();
  const dispose = registry.register('conversation.body', node(child));
  assert.throws(() => registry.register('conversation.body', node(element())), /Multiple entries/);
  assert.throws(() => registry.register('conversation.body', node(child)), /Duplicate node/);
  dispose();
  close();
  const later = element();
  const stop = registry.define('conversation.body', node(later), 'single');
  assert.deepEqual(later.children, []);
  stop();
});

test('a late single owner rejects ambiguous earlier contributions without claiming the outlet', () => {
  const registry = new SlotRegistry();
  const first = registry.register('conversation.body', node(element()));
  const second = registry.register('conversation.body', node(element()));
  assert.throws(() => registry.define('conversation.body', node(element()), 'single'), /Multiple entries/);
  second();
  const outlet = element();
  const release = registry.define('conversation.body', node(outlet), 'single');
  assert.equal(outlet.children.length, 1);
  release();
  first();
});
