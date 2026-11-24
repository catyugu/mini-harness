# @mini-harness/shell

Provides the shell tool and command result rendering.

## Responsibilities

Owns the shell tool and its UI. Uses Approvals for decisions and Process Execution for command execution.

## Structure

`src/server/setup.ts` registers the tool and requests confirmation through the public Approvals interface. `src/browser/` renders command details.

## API

Contributes the `sandbox_shell` tool and the Conversation tool renderer.

## Dependencies

Depends on [Approvals](../approvals/README.md), [Process Execution](../process-execution/README.md) and [Conversation](../conversation/README.md).

## Lifecycle

The `shell` application plugin owns the tool lease and browser contribution. Cancellation follows the run lifetime.

## Configuration

Enable Shell in Plugins. Conversation permissions determine the applicable approval and isolation policy.

## Testing

`tests/approval-api.test.ts` exercises approvals, commands and cancellation.
