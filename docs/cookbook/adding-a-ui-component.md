# Add a UI component

Use a [plugin](creating-a-plugin.md) with a browser entry. The [packaging reference](../plugins.md) defines how to publish the entry and assets. Browser code imports only public browser-safe modules.

A feature contributes to an existing owner rather than modifying the shell. The [browser-panel example](../examples/browser-panel/web.ts) adds a page, a dialog and a message action using the public UI APIs. Its [composer replacement](../examples/browser-panel/web/composer.ts) illustrates a keyed outlet.

To implement a new feature, identify the extension point in [Frontend](../subsystems/frontend.md). Declare its service in `inject`, use the supplied primitives and register through `ctx.effect`. A slot renderer receives a fresh disposal signal; bind DOM listeners and subscriptions to that lifetime. Use a stable key only when replacing a named contribution intentionally.

Mount the built browser entry through the Profile, inspect the view at desktop and mobile widths, then disable and re-enable it. Verify that the prior contribution is restored on replacement removal and that controller/draft state is unchanged. Use [UI Slots](../../packages/ui-slots/README.md) and [UI Layout](../../packages/ui-layout/README.md) for exact contracts.
