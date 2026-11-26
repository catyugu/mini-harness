# Create a plugin

This walkthrough activates a service provider and a route consumer in a disposable Web Profile. It uses the build-checked [greeting service](../examples/greeting-service/plugin.ts) and [greeting route](../examples/greeting-route/plugin.ts). For an independent npm project, use [Task notes](../examples/task-notes/README.md).

## 1. Build the examples

From a checkout, follow [development setup](../development.md), then run:

```sh
pnpm run build
```

The compiled entries are `dist/docs/examples/greeting-service/plugin.js` and `dist/docs/examples/greeting-route/plugin.js`. Keep the two example directories together: the source consumer imports the provider's service type. The output uses public `mini-harness/*` imports.

## 2. Declare the contract

The provider augments the public Cordis `Context` with an `exampleGreeting` service, exports `provide = ['exampleGreeting']`, and supplies the value in `apply` through `ctx.provide`. Its native `Config` schema defines a `prefix` default.

The route consumer exports `inject = ['exampleGreeting', 'harnessRoutes']`. It registers `GET /api/greeting/hello/:name` inside `ctx.effect`, so removal releases the route. Required dependencies determine activation; listing a plugin earlier in YAML is not a substitute for `inject`.

Use the same shape for your own capability. Import types from the [public SDK](../plugins.md), give shared state one service owner, and bind registrations and async work to [Cordis lifetimes](../cordis.md).

## 3. Activate the entries

Choose a fresh Profile name and initialize it:

```sh
node dist/bin/mini-harness.js docs-example --from-default-profile web --dump-config
```

`--from-default-profile` replaces the selected Profile directory. Use a new name or a separate `MINI_HARNESS_HOME` for this exercise. In `~/.mini-harness/profiles/docs-example/cordis.patch.yml`, add the following entries, replacing the absolute paths with your checkout path:

```yaml
plugins:
  - id: greeting-service
    name: /absolute/path/to/mini-harness/dist/docs/examples/greeting-service
    config:
      prefix: Hello
  - id: greeting-route
    name: /absolute/path/to/mini-harness/dist/docs/examples/greeting-route
```

Start it with:

```sh
node dist/bin/mini-harness.js docs-example --no-open
```

Open the printed URL. Plugins should show both entries as active. An authenticated request to `GET /api/greeting/hello/mini-harness` returns `{"greeting":"Hello, mini-harness"}`. See [Transport](../../packages/transport/README.md) for authenticated clients and route semantics.

## 4. Check configuration and cleanup

Change the provider's prefix in the plugin editor and repeat the request. The non-live provider restarts with the accepted config, and its dependent consumer is remounted. Disable the provider: the consumer waits for its dependency and its route is removed. Re-enable it to restore the service and route. Finally stop the instance with `node dist/bin/mini-harness.js stop`.

The existing [composition tests](../../test/plugins/composition.test.ts) exercise these examples, including replacement and disposal. When adapting them, check the corresponding visible behavior and failure path rather than adding a second lifecycle mechanism.

## 5. Package or extend it

An installed npm dependency still needs an explicit Profile entry. Declare server exports, optional metadata and browser assets as described in [SDK and packaging](../plugins.md); use [Profiles](../profiles.md) for dependency installation and scoped activation. Publish compiled JavaScript rather than loading `.ts` files as plugin entries.

Continue with [tools](adding-a-tool.md), [model providers](adding-a-model-provider.md), [child runs](adding-a-subagent-provider.md), [UI contributions](adding-a-ui-component.md), or [settings](adding-a-settings-page.md).
