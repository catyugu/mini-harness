# @mini-harness/models

Owns model discovery, provider settings, credentials and the default provider adapter.

## Responsibilities

Maintains one credential and provider store. Publishes independent catalog and LLM capabilities and tracks the recent application model.

## Structure

`src/manifests/` assembles the store, catalog, LLM transport, preference and administration. `src/server/` contains provider administration and the Pi adapter. `src/shared/` holds catalog data. `src/browser/` implements the provider settings page.

## API

`harnessModels` and `harnessLlm` are independent replaceable capabilities. `@mini-harness/model-catalog` aggregates model sources registered through `harnessModels.register(source, adapter, priority)`, including dynamically resolved model IDs. The catalog registers the source and adapter with one scope, priority and lifetime. Equal-ranked matches are ambiguous and omitted from discovery; they cannot silently select different metadata and transport. Adapter-only overrides via `harnessLlm.register` deliberately reuse the selected source's capabilities. Pi contributes its store through this same paired registration, keeping connection and credentials private. Third-party adapters can own their provider configuration without installing the Pi store. `harnessModelPreference` is optional. `core:model-admin` serves provider settings and the browser catalog.

## Dependencies

Implements [LLM](../llm/README.md) contracts. The Pi SDK is confined to the adapter. Settings persists the recent model.

## Lifecycle

The application store drains credential writes at disposal. Accepted user input from a root user run updates the application preference. Models updates the current selection immediately, notifies browser projections, orders and drains persistence writes, and reports failures independently of run execution.

## Configuration

Provider definitions and credentials are managed through Settings. `core:models.model` defaults to an empty selection.

## Testing

`tests/` verifies the adapter and recent model persistence across scoped calls and restarts.
