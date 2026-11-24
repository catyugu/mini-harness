# @mini-harness/models

Owns model discovery, provider settings, credentials and the default provider adapter.

## Responsibilities

Maintains one credential and provider store. Publishes independent catalog and LLM capabilities and tracks the recent application model.

## Structure

`src/manifests/` assembles the store, catalog, LLM transport, preference and administration. `src/server/` contains provider administration and the Pi adapter. `src/shared/` holds catalog data. `src/browser/` implements the provider settings page.

## API

`harnessModels` and `harnessLlm` are replaceable capabilities. `harnessModelStore` and `harnessModelPreference` are internal. `core:model-admin` serves provider settings and the browser catalog by consuming those capabilities.

## Dependencies

Implements [LLM](../llm/README.md) contracts. The Pi SDK is confined to the adapter. Settings persists the recent model.

## Lifecycle

The application store drains credential writes at disposal. Scoped model selections remain separate from the application preference.

## Configuration

Provider definitions and credentials are managed through Settings. `core:models.model` defaults to an empty selection.

## Testing

`tests/` verifies the adapter and recent model persistence across scoped calls and restarts.
