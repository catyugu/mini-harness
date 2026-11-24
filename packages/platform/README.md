# @mini-harness/platform

Provides operating-system, filesystem and path operations shared by native capabilities.

## Responsibilities

Owns private runtime paths, atomic JSON writes, OS-backed secret protection, isolation discovery and domain errors.

## Structure

`src/` is organized by operation, including paths, JSON, local secrets, isolation and error handling.

## API

Exports narrow workspace entries for path preparation, JSON and local-secret operations, runtime paths and domain errors.

## Dependencies

Uses Node and operating-system interfaces. Features own the policy and persistence formats that use these operations.

## Testing

[System tests](../../test/system/) and the installation check exercise private paths, file operations and platform behavior.
