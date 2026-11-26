# Profiles

A Profile is an independent private npm package under `~/.mini-harness/profiles/<name>/` (or the selected `MINI_HARNESS_HOME`). It declares the application's Cordis entries and scoped compositions. The launcher selects a named Profile; YAML files supply its layers rather than acting as standalone launch targets.

## Select, initialize and inspect

The first ordinary launch initializes the default `web` Profile. Other named Profiles must already exist or be initialized explicitly:

| Command                                             | Effect                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `mini-harness` or `mini-harness web`                | Start the default Web Profile                                             |
| `mini-harness rescue --from-default-profile web`    | Replace the `rescue` Profile with the shipped Web template, then start it |
| `mini-harness --profile rescue --patch ./extra.yml` | Start `rescue` with a temporary overlay; repeat `--patch` for more layers |
| `mini-harness rescue --dump-config`                 | Print the composed raw configuration without mounting plugins             |
| `mini-harness rescue --dump-default-config`         | Print root/bundle composition without user or CLI overlays                |
| `mini-harness --dump-config-schema`                 | Print the YAML layer and Entry-envelope schema                            |
| `mini-harness web --help`                           | Show application-specific options                                         |

`--from-default-profile web` removes and recreates the selected Profile directory, including its local dependencies and patches. It leaves session data and credentials elsewhere in the configuration directory intact. Use a fresh name for experiments. The operation and the package command require the instance to be stopped because they acquire the configuration-directory lock.

Dumps do not import plugins or apply their native schema defaults. The configuration schema describes the layer envelope; each plugin owns its own Config schema. `--detached` is available when the composed layer sets `detached: true`, as the shipped Web bundle does.

## Package layout and bundles

| Path inside the Profile              | Purpose                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| `package.json`                       | Private npm package; dependencies and ordered bundle declarations |
| `cordis.yml`                         | Root layer                                                        |
| `cordis.patch.yml`                   | User overrides and edits accepted through the application         |
| `package-lock.json`, `node_modules/` | Ordinary npm dependency environment, created during installation  |

The manifest selects bundles independently of installed plugins:

```json
{
  "name": "mini-harness-profile-custom",
  "private": true,
  "type": "module",
  "dependencies": {},
  "miniHarness": {
    "profile": {
      "bundles": ["@mini-harness/base", "@mini-harness/web"]
    }
  }
}
```

The built-in [base](../profiles/base.yml) and [Web](../profiles/web.yml) bundles ship inside the single mini-harness npm package. Their names do not require separate installations. A third-party bundle is an ordinary Profile dependency whose package.json declares `miniHarness.bundle.patch` as a relative YAML path or ordered list of paths within that package.

## Layer precedence

The loader applies layers in this order:

1. `cordis.yml` and its includes.
2. Bundle layers in the manifest's declared order.
3. `cordis.patch.yml` and its includes.
4. Extra `--patch` layers in command-line order.

Includes resolve relative to the declaring YAML file and are applied before that file. Cycles, YAML aliases and executable tags are rejected.

Plugin rows merge by stable Entry ID. Later row fields override earlier ones; `config` merges at its top level, so replacing a nested object replaces that entire field. The last layer declaring `scopes` replaces the whole scopes map. The last declared `detached` value wins. Relative module paths resolve from the layer that declares the module name.

CLI overlays are temporary. Saving unrelated runtime settings does not copy the whole overlay into the user layer. See the [Host implementation](../packages/host/src/profile.ts) and [Profile tests](../test/system/profiles.test.ts) for precedence and persistence contracts.

## Entries and overrides

Add entries and overrides to `cordis.patch.yml`:

```yaml
plugins:
  - id: core:web-server
    config:
      port: 3838
  - id: git-diff
    disabled: true
  - id: custom-provider
    name: '@example/custom-provider'
    live: true
    config:
      label: Progress
  - id: local-tool
    name: ./plugins/tool.mjs
  - id: local-panel
    name: /absolute/path/to/local-panel
    client: true
```

| Field      | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `id`       | Stable identity used for overrides and owned configuration                                  |
| `name`     | Shipped module name, installed npm specifier, local built package or JavaScript module path |
| `disabled` | Preserve the declaration/config but leave the entry inactive                                |
| `client`   | Control publication of the entry's declared browser resources                               |
| `live`     | Opt into in-place config updates when the plugin supports them                              |
| `config`   | Raw user-supplied configuration validated by the native schema                              |

An override can omit `name` when an earlier layer defines it. A name-only row receives a stable derived ID; use an explicit ID when referring to the entry from another layer. Duplicate IDs within a single layer are rejected. The fully composed entry must have a module name.

Disabled entries are not imported. Enabled server modules may export an ordinary Cordis function, class or object with `apply(ctx, config)`. A module can instead provide named `apply`, `inject`, `provide` and `Config` exports. YAML does not have a field for selecting an arbitrary exported plugin object. Static metadata is optional; native exports take precedence when loaded. [Plugins](../packages/plugins/README.md) owns resolution and activation, and [SDK packaging](plugins.md) documents public entry/assets conventions.

A package's `/client` export can be declared as a separate Entry with its own config, including for shipped module names. Set `client: false` on the server Entry when publishing its UI separately. Browser entries receive their configuration, so use protected plugin storage for credentials.

## Install and update dependencies

Stop the running instance, then invoke npm through the Profile's package environment:

```sh
mini-harness stop
mini-harness plugin --profile rescue add @example/plugin
mini-harness plugin --profile rescue update @example/plugin
mini-harness plugin --profile rescue remove @example/plugin
```

The three package commands show separate operations, not an installation sequence to run together. They accept ordinary npm arguments, including local directories, tarballs and Git references. npm lifecycle scripts are disabled by default; an explicit `--ignore-scripts=false` opts in. The launcher needs npm alongside Node, or a configured `MINI_HARNESS_NPM_CLI` path.

Installing a dependency does not activate it. Add the corresponding Entry or bundle declaration, then start the Profile again. Remove or disable declarations that refer to a dependency before starting after removal.

## Live configuration and scope composition

The Web Plugins page manages declared entries and writes accepted changes to the active Profile's user layer. Plugins serializes candidate reconciliation, Cordis applies native schema/lifecycle behavior, and Host persists the accepted YAML. A rejected candidate restores the previous composition. By default, non-live changes restart the affected activation and live changes apply in place; native `internal/update` listeners can handle or reject the candidate. See [Cordis](cordis.md) for update semantics. Changing the live composition owner itself requires a Profile restart.

Manual file edits take effect on the next launch. Scope entries and service isolation use the same plugin contract; see [scoped providers](scoped-providers.md) for their syntax and inheritance. Session history, model credentials and plugin-owned data remain separate from Profile configuration; the [configuration map](configuration.md) identifies their owners.
