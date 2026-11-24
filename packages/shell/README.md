# @mini-harness/shell

Provides the shell tool, approval presentation and command results.

## Responsibilities

Owns the shell tool and its UI. Uses Approvals for decisions and Process Execution for command execution.

## Structure

`src/server/setup.ts` registers the tool and approval-facing routes. `src/browser/` renders approvals and command details.

## API

Contributes the `shell` tool, approval controls and the Conversation tool renderer.

## Dependencies

Depends on [Approvals](../approvals/README.md), [Process Execution](../process-execution/README.md) and [Conversation](../conversation/README.md).

## Lifecycle

The `shell` application plugin owns the tool lease, browser contribution and stylesheet. Cancellation follows the run lifetime.

## Configuration

Enable Shell in Plugins. Conversation permissions determine the applicable approval and isolation policy.

## Testing

`tests/approval-api.test.ts` exercises approvals, commands and cancellation.
