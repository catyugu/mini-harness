# File preview

Provides workspace file and conversation attachment previews. The server reads workspace files through the selected File Access provider. The browser opens typed resources through `miniFilePreview`, choosing a sidebar tab or a media dialog as requested by the caller.

- `src/server/` contains the bounded workspace preview and download routes.
- `src/browser/` owns rendering, downloads, and media lifetimes.
- `src/shared/` holds the content types and media detection.

Workspace tabs pass their current access context to File Access. Stored attachment tabs belong to the original conversation. Draft resources have a caller-owned abort signal.
