import { Context, EntryGroup, EntryTree, type EntryOptions } from 'mini-harness/cordis';
import type { ScopeAddress, ScopeBinding } from '@mini-harness/plugin-api/configuration';
import { tagScope } from '@mini-harness/plugin-api/scopes';

type Resolver = (id: string) => ScopeBinding | undefined;
export const sourceName = (key: string) => 'scope-source:' + key.split(':')[0];
const compositionName = (key: ScopeAddress) => 'scope-composition:' + key;

export function lookupScope(ctx: Context, key: ScopeAddress) {
  return (ctx.get(sourceName(key)) as Resolver | undefined)?.(key.slice(key.indexOf(':') + 1));
}

export interface MountedScope {
  context: Context;
  tree: EntryTree;
}

export interface ScopeEntryOptions extends EntryOptions {
  scope: ScopeAddress;
  configured: ReadonlySet<ScopeAddress>;
  plugins(context: Context): EntryOptions[];
}

export function isScopeEntry(options: EntryOptions): options is ScopeEntryOptions {
  return 'scope' in options;
}

/** A configured composition is an ordinary Cordis consumer of its domain and
 * its ancestor compositions. Its activation owns the child entry tree. */
export function scopeEntry(
  root: Context,
  key: ScopeAddress,
  configured: ReadonlySet<ScopeAddress>,
  ancestors: readonly ScopeAddress[],
  isolates: readonly string[],
  plugins: (context: Context) => EntryOptions[],
  mounted: Map<ScopeAddress, MountedScope>,
  failures: Map<ScopeAddress, unknown>,
): ScopeEntryOptions {
  const templates = plugins(root);
  return {
    id: '@scope/' + key,
    context: root,
    module: JSON.stringify([key, isolates, ancestors.filter((item) => configured.has(item))]),
    config: {
      entries: templates.map(({ id, module, config, live }) => ({ id, module, config, live: !!live })),
    },
    scope: key,
    configured,
    plugins,
    live: true,
    inject: [sourceName(key)],
    load: () => ({
      async apply(ctx) {
        const options = () => ctx.fiber.entry!.options as ScopeEntryOptions;
        let tree: EntryTree | undefined;
        let context: Context | undefined;
        ctx.on('internal/update', async () => {
          if (tree && context) await tree.update(options().plugins(context));
        });

        async function mount(owner: Context, parent: Context, binding: ScopeBinding) {
          // Inherit the parent's isolation labels, but own the child fibers here.
          const inherited = owner.extend({ [Context.isolate]: parent[Context.isolate] });
          const group = new EntryGroup(inherited, isolates);
          context = tagScope(group.context, binding.key);
          tree = new EntryTree();
          const state = { context, tree };
          mounted.set(key, state);
          owner.effect(() => async () => {
            mounted.delete(key);
            tree = undefined;
            context = undefined;
            await state.tree.close();
          });
          owner.provide(compositionName(key), state.context);
          await state.tree.update(options().plugins(state.context));
        }

        async function activate(owner: Context, work: () => Promise<void>) {
          try {
            await work();
          } catch (error) {
            failures.set(key, error);
            owner.effect(() => () => {
              if (failures.get(key) === error) failures.delete(key);
            });
          }
        }

        // Resolve topology through the owners' services. A configured ancestor
        // is itself a dependency, so its disposal also disposes this subtree.
        async function connect(
          owner: Context,
          binding: ScopeBinding,
          parent: ScopeAddress | undefined,
          seen: Set<ScopeAddress>,
          nearest?: ScopeAddress,
        ): Promise<void> {
          if (!parent) {
            if (!nearest) return mount(owner, root, binding);
            await owner.inject([compositionName(nearest)], (child) =>
              activate(child, () => mount(child, child.get(compositionName(nearest)) as Context, binding)),
            );
            return;
          }
          if (seen.has(parent)) throw new Error('Cyclic scope ancestry: ' + parent);
          const address = parent;
          await owner.inject([sourceName(address)], (child) =>
            activate(child, async () => {
              const next = lookupScope(child, address);
              if (!next) throw new Error('Configured scope does not exist: ' + address);
              await connect(
                child,
                binding,
                next.parent,
                new Set([...seen, address]),
                nearest ?? (options().configured.has(address) ? address : undefined),
              );
            }),
          );
        }

        await activate(ctx, async () => {
          const binding = lookupScope(ctx, key);
          if (!binding) throw new Error('Configured scope does not exist: ' + key);
          await connect(ctx, binding, binding.parent, new Set([key]));
        });
      },
    }),
  };
}
