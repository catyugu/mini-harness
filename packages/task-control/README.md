# Task Control

The private workspace module owns the two existing, independently selectable Profile entries: `task-control` (background tool execution and routes) and `background-tasks` (the Web panel and its receipt renderers). Both use the existing Runs, Tasks, Sessions and Conversation contracts. There is no new npm entry point.

The optional `task-control` Profile entry registers `start_background` and `task_control`. An eligible tool declares `background: true`; the shared tool invocation path validates and executes it. The accepted receipt identifies its independent Task. `task_control` lists, inspects, waits for, cancels and reads cursor-based output for owned background tools and direct child Runs.

Background execution holds the registered tool's provider and the Session's resource owner. It can call `report` to send a mid-task message. Progress and ordinary output update task projections. Background tool snapshots carry the accepted tool name and arguments. Child Runs keep their conversation output in Session history, not in a duplicate terminal-output stream. Terminal notifications carry the actual scheduler state and the projected business result. Stable notification IDs make acceptance idempotent across restart.

The panel owns the current session's task snapshots and a single cursor-based output reader for its expanded task. Tool receipts reuse the same projected result text and open that reader through View task. Tool names, arguments and projected detail metadata are displayed without interpreting individual tool schemas. Closing the reader, switching sessions or removing the panel releases its lifetime. The panel registers its own `header.actions` contribution. Its activation owns the task projection subscription, session subscription, requests, popover, timer and output reader. Disabling the panel releases these without requiring a change to Layout or Conversation; the generic Tasks scheduler does not own this UI.

See [execution](../../docs/subsystems/execution.md).
