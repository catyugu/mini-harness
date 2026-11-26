# UI Slots

Mounts browser contributions into named outlets. The registry owns selection, ordering and renderer lifetime; the feature declaring an outlet owns its placement and meaning. It does not own conversation state, navigation or configuration.

## Usage and public API

Import types from [`mini-harness/ui-slots`](src/browser/api.ts) and inject `miniSlots` in a browser plugin. `define(name, outlet, kind)` declares an empty element outlet or an owner-supplied placement callback receiving the ordered mounted nodes; `register(name, contribution, options)` contributes an element or renderer. Both return a disposer, which belongs in a Cordis effect.

For example, a plugin can contribute a control to a Layout outlet:

```ts
import type { Context } from 'mini-harness/cordis';
import type {} from 'mini-harness/ui-layout';
import type {} from 'mini-harness/ui-slots';

export const inject = ['miniSlots'];

export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.miniSlots.register(
      'sidebar.actions',
      () => {
        const node = document.createElement('p');
        node.textContent = 'Extension ready';
        return node;
      },
      { key: 'example-status', order: 20 },
    ),
  );
}
```

Features declare additional names by augmenting `SlotMap`. A `single` outlet accepts at most one selected key; `list` is the default and accepts multiple keys. The [composer replacement example](../../docs/examples/browser-panel/web/composer.ts) shows replacing a native renderer while sharing the existing controller.

## Selection and lifetime

- Each name has one outlet owner. Duplicate owners and nonempty outlet containers are rejected.
- Contributions may register before their outlet exists. Removing the outlet unmounts views but preserves contributions for a later owner.
- `key` identifies alternatives for the same contribution; without a key, the element or renderer itself is the identity. Higher `priority` wins for that key, and equal priorities conflict. `order` sorts the selected contributions in ascending display order independently of priority.
- Removing a winning replacement restores the next eligible contribution. A renderer receives a fresh `AbortSignal` for each mount and may return either an element or `{ node, dispose }`. Replacement, outlet removal and unregistration abort the signal, call the optional disposer and remove the node.
- Failed registration removes that candidate and restores eligible contributions. A renderer must release its own external work through its signal or disposer; the registry cannot recover arbitrary side effects outside that lifetime.

The built-in `core:slots` Entry in the [web Profile](../../profiles/web.yml) provides `miniSlots`. It has no configuration. The registry uses UI Runtime's internal keyed-selection utility; it has no feature-service dependencies.

## Implementation and verification

[`registry.ts`](src/browser/registry.ts) implements outlet ownership and mounting. [Registry tests](tests/registry.test.ts) cover early contributions, duplicate identities, single-outlet conflicts, priority, replacement, restoration and failed render cleanup.

See [UI Layout](../ui-layout/README.md) for application outlets and [frontend composition](../../docs/subsystems/frontend.md) for the browser ownership model.
