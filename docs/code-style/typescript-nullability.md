# TypeScript nullability and invariants

**Nullability must represent a real domain state, not the implementer's uncertainty about program correctness.**

Declaring a required value as `T | undefined` transfers responsibility for establishing and maintaining its invariant from the producer to every consumer. When consumers propagate that uncertainty, optional chains, scattered defaults, early returns, repeated checks, and unreachable branches accumulate. A successful type check then provides fewer useful guarantees about the system.

These rules apply to new and changed TypeScript code. Establish invariants at their owners, and keep internal contracts strong and narrow.

## 1. Where nullability belongs

| Situation                                        | Nullable? | Required handling                                          |
| ------------------------------------------------ | --------- | ---------------------------------------------------------- |
| User input, external APIs, deserialization       | Yes       | Validate and convert at the input boundary.                |
| Optional user configuration                      | Yes       | Resolve effective values at the configuration boundary.    |
| Lookup of a potentially absent resource          | Yes       | Handle absence at the direct consumer.                     |
| Genuinely optional domain property               | Yes       | Give absence an explicit meaning.                          |
| Genuinely optional plugin capability             | Yes       | Handle availability during discovery or composition.       |
| Required service dependency                      | No        | Guarantee it through construction or dependency injection. |
| Partially initialized object                     | Avoid     | Fix construction order or model lifecycle stages.          |
| Data guaranteed by the current state             | No        | Express the state invariant in the type.                   |
| Required internal function argument              | No        | Require callers to satisfy the precondition.               |
| Unexpected violation of an invariant             | No        | Treat it as a defect.                                      |
| Type widened to accommodate unrelated call paths | Avoid     | Split or reorganize responsibilities.                      |

Ask whether the system has a legitimate, meaningful behavior when the value is absent. If it does not, nullability is usually a contract defect. Do not add optionality for speculative extensions, compatibility paths, or hypothetical exceptions.

## 2. Resolve uncertainty at the boundary

User configuration can omit fields; effective runtime configuration should contain the required values. Avoid distributing defaults among consumers:

```ts
interface Config {
  timeout?: number;
  maxRetries?: number;
}

function execute(config: Config) {
  const timeout = config.timeout ?? 30000;
  // ...
}

function retry(config: Config) {
  const maxRetries = config.maxRetries ?? 3;
  // ...
}
```

Resolve defaults once, after external data has been validated, and pass the complete configuration onward:

```ts
interface Config {
  timeout: number;
  maxRetries: number;
}

function resolveConfig(input: Partial<Config>): Config {
  return {
    timeout: input.timeout ?? 30000,
    maxRetries: input.maxRetries ?? 3,
  };
}

function execute(config: Config) {
  // Use config.timeout directly.
}
```

The same principle applies to input parsing, resource acquisition, and dependency assembly. Resolve uncertainty at the earliest point where its meaning can be determined. Preserve a nullable field only when downstream behavior genuinely depends on its absence. In particular, let Cordis injection guarantee required services; handle optional capabilities at the composition boundary.

## 3. Represent state invariants in types

Independent optional fields are a poor model for data that must exist together in a particular state. For example:

```ts
interface Session {
  status: 'idle' | 'running';
  run?: Run;
  controller?: AbortController;
}

function stop(session: Session) {
  if (session.status === 'running' && session.run && session.controller) {
    session.controller.abort();
  }
}
```

This representation admits running sessions without a run or controller, idle sessions with active execution data, and partially populated running data. Consumers are left to check combinations that the producer should have ruled out.

Use a discriminated union to encode the relationship:

```ts
type Session =
  | { status: 'idle' }
  | {
      status: 'running';
      run: Run;
      controller: AbortController;
    };

function stop(session: Session) {
  if (session.status === 'running') {
    session.controller.abort();
  }
}
```

Make illegal states unrepresentable: the domain branch narrows the type and exposes the data guaranteed in that state. Use discriminated unions or stage-specific types where real state or lifecycle constraints exist. Independent, genuinely optional properties can remain optional fields. Do not add a state hierarchy merely to eliminate a meaningful optional property.

## 4. Distinguish lookup from required acquisition

Resource lookup can legitimately return no match. Distinguish that contract from an operation that requires an existing resource:

```ts
declare function findSession(id: string): Session | undefined;
declare function requireSession(id: string): Session;
```

`findSession` returns absence as a normal result. `requireSession` returns the required resource or terminates the operation through a defined error contract. Handle a missing resource at the lookup boundary; do not propagate a required resource as nullable through subsequent operations. These names illustrate the contracts, not a requirement to implement both variants for every service.

When a caller already holds the required object, prefer passing that object or the narrow interface actually needed:

```ts
// Repeated lookup introduces uncertainty and a service dependency.
declare function executeById(sessionId: string): void;

// The caller has already acquired the required resource.
declare function execute(session: Session): void;
```

Keep lookup at the boundary that owns resource identity and lifetime. Do not replace repeated lookups with stale references across lifecycle boundaries; acquire the resource where the operation is admitted, then use it directly while its lifetime is guaranteed.

## 5. Optional chaining, fallbacks, and assertions

| Expression            | Legitimate use                                | Contract defect                          |
| --------------------- | --------------------------------------------- | ---------------------------------------- |
| `x?.foo()`            | Genuinely optional object or capability       | Calling a required service               |
| `x ?? defaultValue`   | An explicit meaning for a missing value       | Masking missing internal data            |
| `x \|\| defaultValue` | Intentionally treating all falsy values alike | Confusing zero or false with absence     |
| `if (!x) return`      | A legitimate no-op branch                     | Silently ignoring an invalid state       |
| `x!`                  | Rare invariant the compiler cannot establish  | Forcing a value through the type checker |
| `x as T`              | A justified type conversion or refinement     | Inventing a guarantee without evidence   |

For example, `await runtime?.execute(request)` silently drops a request when a required service is missing. Use `await runtime.execute(request)` with a non-null dependency contract and guarantee its existence during construction or injection.

Do not introduce empty objects, dummy values, defaults, optional chains, or silent returns to conceal broken invariants. If an invariant must be checked at runtime, establish it once at the responsible boundary and fail explicitly on violation. Prefer a narrowing check, a better type, or a corrected producer over a non-null or type assertion. Use assertions only where the guarantee is demonstrable and the compiler cannot express it.

## 6. Distinguish absence from failure

| Type or contract               | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `T`                            | A required, valid value.                                          |
| `T \| undefined`               | Legitimate absence or omission.                                   |
| `T \| null`                    | An explicit empty value, such as intentional clearing.            |
| `T \| null \| undefined`       | Only when omission and explicit emptiness have distinct meanings. |
| `T[]`                          | A collection, which may be empty.                                 |
| `Result<T, E>` or an exception | Operation failure with a defined error contract.                  |
| `unknown`                      | Data not yet validated.                                           |

Do not overload `undefined` to mean a lookup miss, execution failure, unimplemented capability, incomplete initialization, and cancellation. These outcomes require different handling. A legitimate empty collection is represented by `[]`, not an optional collection.

Use explicit result types when callers need to branch on failure categories. Throw errors for defects or failures that cannot be handled locally, following the existing error contract. Do not introduce a general `Result` abstraction solely for uniformity.

## 7. Compiler checks

The recommended target for the compiler configuration is:

```json
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- `strict` includes `strictNullChecks` and `strictPropertyInitialization`.

- `exactOptionalPropertyTypes` distinguishes an omitted optional property from explicitly assigning `undefined`, unless undefined is included in the declared property type.

- `noUncheckedIndexedAccess` reflects possible absence in indexed reads when the key or index is not guaranteed to exist.

The latter checks can reveal substantial existing contract defects. Prefer iteration, tuples, explicit lookup contracts, and validated boundaries to mechanically adding fallbacks or assertions. The actual compiler options are defined by [tsconfig.json](../../tsconfig.json); this document establishes the design direction and does not imply that every recommended flag is already enabled.

## 8. Review rules

Apply these rules when implementing or reviewing changes:

1. Default to non-null types for internal structures and required function parameters.
2. Require a legitimate, identifiable domain meaning for each nullable value.
3. Centralize external validation, configuration defaults, and dependency assembly at their respective boundaries.
4. Guarantee required dependencies through constructors, factories, or dependency injection.
5. Model state-dependent data using discriminated unions or stage-specific types.
6. Fix call paths, initialization order, and lifetime ownership instead of widening internal types.
7. Do not use fallbacks, optional chains, empty objects, or silent returns to conceal broken invariants.
8. Do not fabricate strong contracts with non-null assertions or unjustified type assertions.
9. When multiple consumers repeat checks for one nullable value, first reconsider its producer and the contract it exposes.
10. Do not introduce optionality for hypothetical extensions, compatibility, or exceptional situations.

**Strong contracts and loose coupling belong together.** Reduce the information one module needs to know about another while preserving the guarantees it can rely on. Weak guarantees spread defensive logic throughout the system and make otherwise independent modules harder to maintain. See [engineering conventions](../conventions.md) for the broader architectural principles.
