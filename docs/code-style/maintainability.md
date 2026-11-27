# Maintainable implementation

Prefer direct, explicit code with narrow contracts. Add abstraction and state only for actual requirements; remove superseded paths as part of the change.

## Structure and dependencies

| Rule                                                 | Avoid                                                                 | Prefer                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Use existing mechanisms first.                       | Parallel service registries, event buses, lifecycle managers          | Native Cordis services, effects, and scopes            |
| Keep dependency direction explicit.                  | Infrastructure branching on feature names                             | Feature-owned contributions through a narrow interface |
| Keep abstractions proportional to the problem.       | Factory/adapter layers with one forwarding implementation             | Direct implementation until a real variation exists    |
| Group code by responsibility.                        | Fragmented one-function modules or generic `utils.ts` dumping grounds | Cohesive modules named for their purpose               |
| Keep public surfaces small.                          | Exporting internals for convenient cross-package access               | Export only the contract consumers need                |
| Remove superseded paths.                             | Legacy aliases, fallback providers, unused config flags               | Update callers and delete the old implementation       |
| Extract shared semantics, not incidental similarity. | Universal helpers that encode unrelated feature policies              | A shared primitive for a stable common contract        |

Use actual plugin injection and contribution contracts; see [Cordis](../cordis.md) and [engineering conventions](../conventions.md).

## Data and state ownership

| Rule                                       | Avoid                                                         | Prefer                                                   |
| ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| One authoritative owner per shared state.  | Mirrored mutable fields synchronized by listeners             | Owner state plus read-only projections or derived values |
| Derive instead of storing redundant state. | Independent `items` and `itemCount` fields                    | `items.length`                                           |
| Expose intent through types and names.     | `data: any`, generic dictionaries, overloaded flags           | Typed records, explicit variants, names with units       |
| Centralize values and normalization.       | Repeated constants, schema defaults, or format conversions    | One authoritative schema or boundary conversion          |
| Keep changes localized.                    | An unrelated service mutating another service's internals     | Owner operations with explicit inputs                    |
| Respect semantic identity and lifetime.    | Global mutable caches of scoped services or selected sessions | Resolve from the correct scope and pass required values  |

```ts
// Avoid: two independently mutable representations.
type WeakSelection = {
  selectedIds: string[];
  selectedCount: number;
};

// Prefer: store the fact once.
function selectedCount(selectedIds: readonly string[]) {
  return selectedIds.length;
}
```

## Errors and asynchronous work

| Rule                                        | Avoid                                                      | Prefer                                                            |
| ------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Handle errors only with a defined policy.   | `catch {}` or a catch-all fallback                         | Recover a known condition; propagate unexpected errors            |
| Report failure once at its owning boundary. | Log and rethrow at every layer                             | Preserve the cause; let the responsible boundary report it        |
| Keep cancellation distinct from success.    | Returning an empty success result on abort                 | Propagate cancellation through the operation contract             |
| Give async work an owner.                   | Floating promises, independent timers, unmanaged listeners | Await work or register it with the owning lifetime                |
| Use one lifecycle and cancellation path.    | Mirrored controllers and ad hoc teardown flags             | Pass the existing signal; use owner-managed cleanup               |
| Use events for observable changes.          | Repeated polling of already observable state               | Subscribe through the existing owner and dispose the subscription |

```ts
// Avoid: failure becomes indistinguishable from a valid empty file.
const text = await readFile(path, 'utf8').catch(() => '');

// Prefer: recover only if absence is legitimate for this operation.
async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}
```

```ts
// Avoid: unowned work that may outlive plugin disposal.
void refresh();

// Prefer: register activation-owned work when it must be drained.
await ctx.fiber.run((signal) => refresh(signal));
```

## Readability and verification

| Rule                                    | Avoid                                                           | Prefer                                                       |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Use ordinary language and control flow. | Invented jargon, nested ternaries, clever one-liners            | Domain names and straightforward branches                    |
| Keep interfaces purpose-specific.       | Functions with several unrelated boolean mode flags             | Separate operations or an explicit domain variant            |
| Use comments for non-obvious contracts. | Comments translating each statement into prose                  | Explain invariants, units, lifetime, or necessary trade-offs |
| Keep UI concerns in their layers.       | Feature checks in shared UI primitives; duplicated theme values | Feature-owned behavior; common tokens and controls           |
| Fix the source of defects.              | Special cases for failing tests or speculative compatibility    | Repair the contract and update affected regression tests     |
| Do not optimize by arbitrary metrics.   | Splitting functions only for length; arbitrary test counts      | Cohesive logic and meaningful verification                   |

Before adding a wrapper, fallback, cache, mode, or dependency, identify the concrete requirement it serves. Prefer deletion or a stronger existing contract when either solves the problem.

See [Tests](testing.md) and [Module imports](module-imports.md) for verification and dependency boundaries.

## Browser views

- The container allocates space and the component owns its internal DOM, styles and interaction. Share tokens, documented CSS primitives and public component contracts. Keep selectors and DOM operations within the owning component.
- Use flex, grid and container queries for ordinary layout. Use one source for responsive modes that also drive input, focus or modality. Derive CSS variables and ARIA from owned state.
- Keep reusable primitives independent of features. Put model selection, conversation controls and other feature-specific views in their owning plugins. Use stable IDs for object identity and treat titles as changeable display text.
