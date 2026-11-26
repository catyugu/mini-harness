# Create a plugin

A plugin is an ordinary Cordis module. Start with the [standalone Task notes example](../examples/task-notes/README.md) for an independently compiled TypeScript project that consumes the published SDK. For a minimal service provider, see [greeting-service/plugin.ts](../examples/greeting-service/plugin.ts) and its [route consumer](../examples/greeting-route/plugin.ts).

1. Create a module/package with a server entry exported through package.json (or a local built JavaScript module). Import `Context` from `mini-harness/cordis`; import any domain types from their public SDK paths.
2. Declare required services with `inject`, provided services with `provide`, and implement `apply(ctx, config)`. A service provider supplies its service through `ctx.provide`. Bind every registration to an effect. See [Cordis](../cordis.md).
3. Build the module. Add a local entry to the active Profile's `cordis.patch.yml`:

```yaml
plugins:
  - id: example-greeting
    name: /absolute/path/to/greeting-service
```

Use the built package path (or module file), not a TypeScript source path. If you install an npm dependency into the Profile, you still need an explicit entry; see [Profiles](../profiles.md).

4. Start the Profile. Inspect Plugins for the entry and its diagnostics. Disable it and verify its registrations are removed. Missing injected services leave it waiting; supply the required services rather than changing startup order.

The [SDK and packaging reference](../plugins.md) describes optional metadata, server/client resources and the service index. Next choose [tools](adding-a-tool.md), [models](adding-a-model-provider.md), [UI](adding-a-ui-component.md), or [settings](adding-a-settings-page.md).
