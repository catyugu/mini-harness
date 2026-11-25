# Plugin examples

Copy each example directory into your mini-harness plugins directory under its current name.

| Example                           | Enablement                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greeting service + Greeting route | Enable both as application plugins. The greeting route consumes the service at `GET /api/extensions/greeting-route/hello?name=mini-harness`.                                |
| Process preview                   | Enable it and set `providers.harnessProcess` to `process-preview`. Shell still asks for approval and displays the proposed command without starting a process.              |
| Scoped greeting                   | Enable Greeting service and select `scoped-tool` in a `session:<id>` override. It exposes the tool and its presentation transform to that conversation and its descendants. |
| [Task notes](task-notes)          | Standalone strict TypeScript example for the public SDKs. Run `npm install` and `npm run build`, then use `MINI_HARNESS_DEV_PLUGIN` with the example’s absolute directory.  |
| Example panel                     | Enable it as an application plugin. It contributes a sidebar page, modal, settings category and assistant message action.                                                   |

See [Plugin development](../plugins.md) for the settings format and lifecycle contract.
