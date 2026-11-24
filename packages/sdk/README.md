# @mini-harness/sdk

Defines the two published plugin entry points for mini-harness.

## Responsibilities

Collects the capability APIs, types and extension points that external server and browser plugins can use.

## Structure

`src/plugin.ts` is the server entry. `src/browser-plugin.ts` is the browser entry.

## API

Install `mini-harness` and import `mini-harness/plugin` or `mini-harness/browser-plugin`. Publish services using Cordis `ctx.provide`; the public `ServiceMap` augmentation also types the server Context. Browser replacements use `miniComposer` for editing and `miniConversation` for current history and run state. Execution handles cancel only their own run. See the [plugin guide](../../docs/plugins.md) for examples.

## Dependencies

References capability-owned APIs. Runtime implementations and installed plugin management stay with those capabilities.

The [Task notes example](../../docs/examples/task-notes) compiles against the installed SDK and exercises session access, managed execution, approvals, records and browser contributions.

## Testing

`pnpm run pack:verify` compiles and runs consumers against an independent npm installation.
