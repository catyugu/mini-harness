# @mini-harness/skills

Discovers skill instructions and makes them available to Agent and the composer.

## Responsibilities

Owns skill roots, discovery, explicit invocation, the `load_skill` tool and the skill picker.

## Structure

`src/server/loader.ts` resolves skill files. `src/server/setup.ts` supplies prompt and input contributions. `src/browser/setup.ts` contributes the picker.

## API

Contributes to `promptExtensions`, `agentExtensions`, Tools and the Conversation composer.

## Dependencies

Uses [Agent](../agent/README.md) to insert accepted skill content and [Workspaces](../workspaces/README.md) to resolve project roots.

## Lifecycle

The `skills` application plugin owns its tool registration, routes and browser picker.

## Configuration

Skill discovery uses the application and workspace directories. Enable the plugin in Plugins.

Skill tool bindings and list requests use the public session access and scope preparation APIs.

## Testing

`tests/loader.test.ts` covers discovery and loading. [Agent HTTP tests](../../test/system/agent-http.test.ts) cover committed skill input.
