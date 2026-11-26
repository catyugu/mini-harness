# TypeScript nullability and invariants

**Nullability must represent a legitimate domain state. The producer owns the invariant; consumers should be able to rely on it.**

| Rule                                            | Avoid                                                      | Prefer                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Required internal data is non-null.             | `service?: Service` for a required dependency              | `service: Service`, guaranteed by injection                                |
| Resolve external uncertainty once.              | Defaults or validation repeated in consumers               | Validate `unknown` and resolve effective config at entry                   |
| Use absence only when meaningful.               | `T \| undefined` for incomplete initialization or a defect | Complete construction or explicit lifecycle stages                         |
| Encode state-dependent fields together.         | `running: boolean; run?: Run`                              | A discriminated union of idle and running states                           |
| Distinguish lookup from required access.        | Repeated nullable lookups by ID                            | `find(id)` for optional lookup; required value or explicit error otherwise |
| Keep optional capability checks at composition. | `ctx.get('requiredService')?.execute()`                    | Required `inject` and direct service access                                |
| Do not conceal broken invariants.               | `runtime?.execute()`; `value ?? {}`                        | A non-null contract or one explicit invariant check                        |
| Do not confuse falsy values with absence.       | `timeout \|\| defaultTimeout`                              | `timeout ?? defaultTimeout` when omission is legal                         |
| Do not fabricate a stronger type.               | `value!`, `value as T`, or double assertions without proof | Narrow the type or fix the producer                                        |

## Effective configuration

```ts
type Config = { timeoutMs: number };

// Avoid: every consumer resolves its own defaults.
function executeWithDefaults(input: Partial<Config>) {
  return run(input.timeoutMs ?? 30000);
}

// Prefer: resolve validated input once, at configuration assembly.
function resolveConfig(input: Partial<Config>): Config {
  return { timeoutMs: input.timeoutMs ?? 30000 };
}

function execute(config: Config) {
  return run(config.timeoutMs);
}
```

## State and resource contracts

```ts
// Avoid: illegal field combinations are representable.
type WeakSession = {
  status: 'idle' | 'running';
  run?: Run;
  controller?: AbortController;
};

// Prefer: the state establishes the available data.
type Session =
  | { status: 'idle' }
  | { status: 'running'; run: Run; controller: AbortController };

function stop(session: Session) {
  if (session.status === 'running') session.controller.abort();
}
```

```ts
// Avoid: repeated lookup of an already acquired resource.
declare function executeById(id: string): void;

// Prefer: acquire once at the owning boundary.
declare function findSession(id: string): Session | undefined;
declare function requireSession(id: string): Session;
declare function executeSession(session: Session): void;
```

These names illustrate distinct contracts; do not add both lookup methods without a consumer. Pass acquired resources directly while their lifetime is guaranteed.

## Absence and failure

| Type                       | Meaning                                          |
| -------------------------- | ------------------------------------------------ |
| `T`                        | Required value.                                  |
| `T \| undefined`           | Legitimate absence or omission.                  |
| `T \| null`                | Explicit emptiness or clearing.                  |
| `T \| null \| undefined`   | Only when omission and clearing differ.          |
| `T[]`                      | Collection, possibly empty.                      |
| Exception or typed failure | Operation failure, following its error contract. |
| `unknown`                  | Data not yet validated.                          |

Do not use `undefined` interchangeably for cancellation, failed execution, missing resources, and unfinished initialization. Do not add a general result wrapper unless callers need to branch on failure types.

## Compiler checks

Keep `strict` enabled. The recommended target also includes `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; actual options live in [tsconfig.json](../../tsconfig.json). Address diagnostics with better contracts, narrowing, iteration, or tuples rather than scattered fallbacks and assertions.

Repeated downstream null checks are a reason to reconsider the producer and its contract, not to propagate optionality further.
