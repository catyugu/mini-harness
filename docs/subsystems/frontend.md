# Frontend composition

The Web interface is a separate Cordis graph. Server services publish a bootstrap and change feed; [UI Runtime](../../packages/ui-runtime/README.md) loads browser modules and synchronizes remote projections. Browser features declare their dependencies just as server features do.

| Layer                                                          | Owner                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Visual tokens and scheme                                       | [UI Theme](../../packages/ui-theme/README.md)           |
| Controls, icons and sanitized Markdown                         | [UI Primitives](../../packages/ui-primitives/README.md) |
| Outlet registry and renderer selection                         | [UI Slots](../../packages/ui-slots/README.md)           |
| Responsive frame, pages, dialogs and workspace tabs            | [UI Layout](../../packages/ui-layout/README.md)         |
| Conversation selection, drafts, history and composer contracts | [Conversation](../../packages/conversation/README.md)   |
| Configuration UI contributions                                 | [Settings](../../packages/settings/README.md)           |

A feature contributes a page, renderer or command rather than replacing the application shell. A keyed renderer can replace presentation while keeping the underlying controller state. Mounting and disposal belong to the appropriate activation or view lifetime; do not retain a removed view's signal or listeners. Shared primitives and tokens are optional building blocks; features can supply arbitrary native DOM and their own styles. The startup stylesheet declares the reset, theme, primitives and layout layers. Unlayered feature styles override these defaults regardless of activation order. Verify narrow and wide layouts.

## Workspace resources

Files owns browsing, search and path completion. Git Diff contributes change views. File Preview renders workspace files, session-owned attachments and draft resources. The server selects the scoped File Access provider; the browser opens typed resources in workspace-owned tabs or media dialogs. Sessions retains original attachment bytes. The raw user text and history preserve the resource reference; presentation is a projection.

See [transport](transport.md), [UI cookbook](../cookbook/adding-a-ui-component.md) and [browser examples](../examples/README.md).
