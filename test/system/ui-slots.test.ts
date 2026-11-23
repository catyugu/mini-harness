import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotRegistry } from '@mini-harness/ui-slots/registry';

class ElementStub {
  children: ElementStub[] = [];
  parent?: ElementStub;
  get childElementCount() { return this.children.length; }
  replaceChildren(...nodes: ElementStub[]) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    for (const child of nodes) this.insertBefore(child, null);
  }
  insertBefore(child: ElementStub, next: ElementStub | null) {
    child.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, child);
    child.parent = this;
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

test('overrides restore the previous contribution and release its node and decorators', () => {
  const registry = new SlotRegistry();
  const outlet = element(), base = element(), replacement = element(), wrapper = element(), sibling = element();
  const lifetimes: AbortSignal[] = [];
  const disposed: string[] = [];
  const stop = registry.define('sidebar.primary', node(outlet));
  registry.register('sidebar.primary', node(sibling), 20);
  registry.registerKeyed('sidebar.primary', 'button', (signal) => {
    lifetimes.push(signal);
    return { node: node(base), dispose: () => disposed.push('base') };
  });
  const removeDecoration = registry.decorate('sidebar.primary', 'button', (child, signal) => {
    lifetimes.push(signal);
    wrapper.replaceChildren(child as unknown as ElementStub);
    return { node: node(wrapper), dispose: () => disposed.push('wrap') };
  });
  assert.deepEqual(outlet.children, [wrapper, sibling]);
  assert.deepEqual(wrapper.children, [base]);

  const removeReplacement = registry.registerKeyed('sidebar.primary', 'button', () =>
    ({ node: node(replacement), dispose: () => disposed.push('replacement') }));
  assert.deepEqual(disposed, ['wrap', 'base']);
  assert.ok(lifetimes.slice(0, 2).every(({ aborted }) => aborted));
  assert.deepEqual(wrapper.children, [replacement]);

  removeReplacement();
  assert.deepEqual(disposed, ['wrap', 'base', 'wrap', 'replacement']);
  assert.deepEqual(wrapper.children, [base]);
  removeDecoration();
  assert.deepEqual(outlet.children, [base, sibling]);
  assert.equal(lifetimes.at(-2)?.aborted, false);
  assert.equal(lifetimes.at(-1)?.aborted, true);
  stop();
  assert.ok(lifetimes.every(({ aborted }) => aborted));
});

test('keyed priority is explicit and a failed replacement retains the mounted instance', () => {
  const registry = new SlotRegistry();
  const outlet = element(), preferred = element(), lower = element();
  const stop = registry.define('sidebar.primary', node(outlet));
  let lifetime: AbortSignal | undefined;
  registry.registerKeyed('sidebar.primary', 'control', (signal) => {
    lifetime = signal;
    return node(preferred);
  }, { priority: 10 });
  registry.registerKeyed('sidebar.primary', 'control', () => node(lower));
  assert.throws(() => registry.registerKeyed('sidebar.primary', 'control', () => {
    throw new Error('render failed');
  }, { priority: 20 }), /render failed/);
  assert.deepEqual(outlet.children, [preferred]);
  assert.equal(lifetime?.aborted, false);
  stop();
  assert.equal(lifetime?.aborted, true);
});
