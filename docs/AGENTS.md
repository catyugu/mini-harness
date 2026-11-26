# Documentation rules

Documentation is part of the implementation. Maintain English Markdown in the repository; do not maintain a parallel generated manual, translation tree, or archive.

## One home per fact

| Information                                                    | Authoritative home                      |
| -------------------------------------------------------------- | --------------------------------------- |
| Public type, signature, default, validation                    | Exported source or configuration schema |
| Package behavior, ownership, lifecycle and extension contracts | Owning package README                   |
| Cross-package coordination                                     | Relevant subsystem reference            |
| Global structure and reading order                             | Architecture and documentation index    |
| Profile file format, layer precedence and scope composition    | Configuration references                |
| End-user workflows                                             | User guide                              |
| Step-by-step extension development                             | Cookbook and linked runnable examples   |
| Build, tests and distribution                                  | Development guide                       |

Other documents should link to the owner rather than duplicate its reference material. A short contextual sentence or quick-start example is useful; a second API catalog or full description is not.

## Writing package READMEs

Begin with the problem solved and its boundary. Use the applicable headings, not a mandatory boilerplate template:

- Responsibilities: owned state, resources, and what belongs elsewhere.
- Usage: the smallest meaningful invocation or Profile entry using actual public exports.
- Public API: services, exported types, events and observable semantics; link to source.
- Configuration: link the schema, describe defaults or update semantics only where they matter.
- Lifecycle and ownership: admission, cancellation, disposal, errors and invariants.
- Dependencies and extension points: required versus optional services and how callers contribute or replace behavior.
- Implementation: only important design decisions or non-obvious invariants.
- Limitations and testing: guarantees not made, contract tests, and targeted verification.
- Related documentation: link cross-package coordination or tutorials.

Libraries should document functions and invariants, not invented services or configuration. UI plugins should document contributions, lifetime and shared state instead of listing every DOM file. Composition packages should document entry resolution and activation. A small package may need only a few sections.

## Verification and maintenance

Read actual source, exported types, schemas, manifests, and relevant tests. Use the root package.json exports for external SDK examples, not private workspace imports. Reuse build-checked examples in docs/examples where possible; distinguish illustrative snippets from verified runnable examples. Test significant new examples where practical.

Keep descriptions of current behavior separate from normative design rules. Do not describe intended but unimplemented features as present. Delete superseded references rather than archiving them. Update all affected links when moving a document. Run the existing formatter; keep the PR focused and do not introduce documentation infrastructure without a demonstrated need.
