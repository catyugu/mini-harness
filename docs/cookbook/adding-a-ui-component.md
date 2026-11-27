# Add a UI component

The browser runs its own Cordis graph. Start with the build-checked [Example panel](../examples/browser-panel/web.ts), which contributes a sidebar page, a dialog, a settings category and an assistant-message action. Its optional [composer renderer](../examples/browser-panel/web/composer.ts) demonstrates replacing presentation while sharing the existing draft/controller state.

## 1. Choose the owning extension point

Use [UI Layout](../../packages/ui-layout/README.md) for pages, dialogs and workspace tabs; [Conversation](../../packages/conversation/README.md) for message actions, history renderers and composer state; and [UI Slots](../../packages/ui-slots/README.md) for a declared outlet. The [frontend reference](../subsystems/frontend.md) maps these owners.

The example injects only the services it uses, builds controls with `miniPrimitives`, and registers contributions inside `ctx.effect`. Its page and dialog live with the browser plugin. A slot renderer receives a fresh signal for each render; bind view listeners and subscriptions to that signal so replacement releases them.

## 2. Publish the browser entry

Build the repository. The example's compiled directory contains `plugin.js`, `web.js`, metadata and the `web/` module directory. Add it to your [example Profile](creating-a-plugin.md):

```yaml
plugins:
  - id: example-panel
    name: /absolute/path/to/mini-harness/dist/docs/examples/browser-panel
    client: true
    config:
      replaceComposer: false
```

The [packaging reference](../plugins.md) describes explicit `browser`, `browserDirectory` and `browserStyles` metadata and the npm `./client` convention. Use dedicated browser output and public browser-safe SDK imports; server dependencies cannot be imported into the browser graph.

## 3. Exercise the contributions

Open **Example panel** in the sidebar and use **Preview** to open its dialog. Open **Settings → Browser panel** for its informational category. On an assistant turn, **Use message in draft** inserts the raw turn text through the existing composer model.

Set `replaceComposer: true` to select the example's renderer for `conversation.composer-view`. It uses the same `composer` key at a higher priority, so it replaces that contribution. Type a draft, switch conversations, and remove the example: the standard renderer returns with controller/draft state intact. [UI Slots](../../packages/ui-slots/README.md) owns priority, conflict and disposal rules.

## 4. Check layout and disposal

Inspect the component at desktop and mobile widths. Verify keyboard labels/focus, scrolling, and that disabling/re-enabling the entry leaves one set of controls and listeners. Use [browser composition tests](../../test/browser/plugins.spec.ts) for replacement scenarios. Register requests through `browserRequest` from `mini-harness/ui-runtime/http` so they share the authenticated client and plugin lifetime.
