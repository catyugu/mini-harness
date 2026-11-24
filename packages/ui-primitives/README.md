# @mini-harness/ui-primitives

Provides reusable browser controls, icons and sanitized Markdown rendering.

## Responsibilities

Owns base controls and styles, icon hydration, Markdown parsing and sanitization.

## Structure

`src/browser/` contains control helpers, icons, Markdown, the browser setup and stylesheet. The build copies the pinned Markdown and sanitizer vendors.

## API

`miniPrimitives` supplies controls. Internal feature modules also import the browser helpers.

## Dependencies

Uses [UI Theme](../ui-theme/README.md) for visual tokens and the pinned Marked and DOMPurify distributions.

## Lifecycle

`core:primitives` mounts after the theme and cleans up browser resources when disposed.

## Testing

[Rendering browser tests](../../test/browser/rendering.spec.ts) exercise Markdown and unsafe input.
