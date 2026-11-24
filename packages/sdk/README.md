# @mini-harness/sdk

Public entry points for installed plugins in the single mini-harness npm package.

## Responsibilities

Exports server and browser domain types and helpers. Plugin declarations and service augmentation use `mini-harness/cordis`.

## Structure

`src/plugin.ts` exports server contracts and `src/browser-plugin.ts` exports browser contracts. The runtime is built from [vendor/cordis](../../vendor/cordis/README.md).

## API

Import server contracts from `mini-harness/plugin` and browser contracts from `mini-harness/browser-plugin`. See the [plugin guide](../../docs/plugins.md).

## Testing

`pnpm run pack:verify` compiles the SDK and runs the Task notes example in an independent npm installation.
