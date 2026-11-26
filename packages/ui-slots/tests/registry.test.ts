import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotRegistry } from '../src/browser/registry.ts';

class ElementStub {
  children: ElementStub[] = [];
  parent?: ElementStub;
  get childElementCount() {
    return this.children.length;
  }
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
  const alpha = element(),
    beta = element();
  const removeAlpha = registry.register('sidebar.actions', node(alpha), { order: 20 });
  const removeBeta = registry.register('sidebar.actions', node(beta), { order: 5 });
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
  assert.throws(
    () => registry.register('conversation.body', node(child)),
    /Conflicting contribution priority/,
  );
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

test('overrides restore the previous contribution and release its node', () => {
  const registry = new SlotRegistry();
  const outlet = element(),
    base = element(),
    replacement = element(),
    sibling = element();
  const lifetimes: AbortSignal[] = [];
  const disposed: string[] = [];
  const stop = registry.define('sidebar.primary', node(outlet));
  registry.register('sidebar.primary', node(sibling), { order: 20 });
  registry.register(
    'sidebar.primary',
    (signal) => {
      lifetimes.push(signal);
      return { node: node(base), dispose: () => disposed.push('base') };
    },
    { key: 'button' },
  );
  assert.deepEqual(outlet.children, [base, sibling]);

  const removeReplacement = registry.register(
    'sidebar.primary',
    () => ({
      node: node(replacement),
      dispose: () => disposed.push('replacement'),
    }),
    { key: 'button', priority: 1 },
  );
  assert.deepEqual(disposed, ['base']);
  assert.ok(lifetimes.slice(0, 1).every(({ aborted }) => aborted));
  assert.deepEqual(outlet.children, [replacement, sibling]);

  removeReplacement();
  assert.deepEqual(disposed, ['base', 'replacement']);
  assert.deepEqual(outlet.children, [base, sibling]);
  assert.equal(lifetimes.at(-1)?.aborted, false);
  stop();
  assert.ok(lifetimes.every(({ aborted }) => aborted));
});

test('a failed keyed replacement retains the mounted instance', () => {
  const registry = new SlotRegistry();
  const outlet = element(),
    preferred = element();
  const stop = registry.define('sidebar.primary', node(outlet));
  let lifetime: AbortSignal | undefined;
  registry.register(
    'sidebar.primary',
    (signal) => {
      lifetime = signal;
      return node(preferred);
    },
    { key: 'control' },
  );
  assert.throws(
    () =>
      registry.register(
        'sidebar.primary',
        () => {
          throw new Error('render failed');
        },
        { key: 'control', priority: 1 },
      ),
    /render failed/,
  );
  assert.deepEqual(outlet.children, [preferred]);
  assert.equal(lifetime?.aborted, false);
  stop();
  assert.equal(lifetime?.aborted, true);
});

test('keyed priority is independent of display order and activation order', () => {
  const registry = new SlotRegistry();
  const outlet = element(),
    base = element(),
    replacement = element(),
    sibling = element();
  const stop = registry.define('sidebar.primary', node(outlet));
  const removeReplacement = registry.register('sidebar.primary', () => node(replacement), {
    key: 'button',
    order: 30,
    priority: 1,
  });
  const removeBase = registry.register('sidebar.primary', () => node(base), { key: 'button', order: 0 });
  registry.register('sidebar.primary', node(sibling), { order: 20 });
  assert.deepEqual(outlet.children, [sibling, replacement]);
  assert.throws(
    () => registry.register('sidebar.primary', () => node(element()), { key: 'button', priority: 1 }),
    /Conflicting contribution priority/,
  );
  removeReplacement();
  assert.deepEqual(outlet.children, [base, sibling]);
  removeBase();
  stop();
});

test('an outlet can place the original ordered nodes across containers without remounting', () => {
  const registry = new SlotRegistry();
  const inline = element(),
    overflow = element(),
    alpha = element(),
    beta = element();
  const lifetimes: AbortSignal[] = [];
  const close = registry.define('conversation.header', (nodes) => {
    inline.replaceChildren(...(nodes.slice(0, 1) as unknown as ElementStub[]));
    overflow.replaceChildren(...(nodes.slice(1) as unknown as ElementStub[]));
  });
  const removeAlpha = registry.register(
    'conversation.header',
    (signal) => {
      lifetimes.push(signal);
      return node(alpha);
    },
    { order: 10 },
  );
  const removeBeta = registry.register('conversation.header', node(beta), { order: 0 });
  assert.deepEqual(inline.children, [beta]);
  assert.deepEqual(overflow.children, [alpha]);
  assert.equal(lifetimes.length, 1);
  assert.equal(lifetimes[0]?.aborted, false);
  removeBeta();
  assert.deepEqual(inline.children, [alpha]);
  assert.deepEqual(overflow.children, []);
  assert.equal(lifetimes[0]?.aborted, false);
  removeAlpha();
  close();
  assert.equal(lifetimes[0]?.aborted, true);
});
