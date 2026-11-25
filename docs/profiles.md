# Profiles

The CLI starts the shipped Web Profile by default. `mini-harness --profile web` selects it explicitly. The package carries [base.yml](../profiles/base.yml) and [web.yml](../profiles/web.yml). The base is a shared configuration fragment.

Choose another named Profile with `mini-harness --profile custom`, which reads
`~/.mini-harness/profiles/custom/cordis.yml`, or pass an explicit YAML file with
`mini-harness --profile ./application.yml`. Custom Profiles do not implicitly include Web or base.

The launcher loads the base, then Web, then `~/.mini-harness/profiles/web/cordis.yml` (under `MINI_HARNESS_HOME` if set). The user file is optional. Each layer can patch an entry by ID. Configuration properties merge at the top level, and the last definition of each property wins. The order of entries is for readability. Each Profile or fragment may include other YAML files.
Includes resolve relative to the file declaring them, run before that file's own entries, and may
be nested. Cyclic includes are rejected. A later layer can replace the module name or patch
individual configuration properties. Cordis waits for injected services and tears down consumers
before releasing their providers.

An application does not need the Web interface or plugin manager if its entries are ordinary
Cordis plugins. For example:

```yaml
include:
  - ./shared.yml
plugins:
  - id: custom-tool
    name: ./plugins/tool.mjs
    config:
      label: Progress
  - id: provider
    name: '@example/provider'
    disabled: true
```

Local paths and npm package exports resolve relative to the YAML file that supplies the module name.
Native entries export a Cordis function, class, or object with `apply(ctx, config)`. They do not
need `plugin.json`. Disabled external entries are not imported. Native entries currently use
startup YAML configuration; edit the Profile and restart to change them.

```yaml
plugins:
  - id: core:web-server
    config:
      port: 3838
  - id: git-diff
    name: '@mini-harness/git-diff'
    disabled: true
  - id: task-notes
    name: installed:task-notes
    client: true
    config:
      label: Progress
```

`name` identifies a plugin. Built-in plugins use stable scoped names such as `@mini-harness/conversation-history` or `@mini-harness/ui-settings`. Each workspace package declares the names it owns, and the build resolves them inside the single `mini-harness` distribution. An installed plugin uses `installed:<id>`. Installing a plugin adds its files and metadata. A Profile entry controls activation. `client` controls whether a configured module contributes its browser entry to the Web bootstrap.

Use `providers` for service-to-entry selections, `browserProviders` for browser service selections, and `scopes` for workspace and conversation overrides. See [scoped providers](scoped-providers.md). The shipped Web Profile still declares required managed entries; native Entries use Cordis dependency waiting. Custom YAML tags and aliases are rejected. Changes made outside the app take effect on restart.

The Web Plugins page updates the same YAML. Candidate changes are validated before publishing committed settings, and a failed activation restores the prior entries. Domain settings such as tool grants remain in `settings.json`. The first successful startup of the default Web Profile migrates old plugin, provider, scope and port settings to that Profile. Model definitions, credentials, conversations, attachments and plugin data keep their existing locations.

The layering and lifetime follow the [DSH Profile launcher](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/profile-boot.ts) and its [base patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml).
