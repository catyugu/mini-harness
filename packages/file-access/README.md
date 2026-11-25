# File access

`harnessFileAccess.native` exposes Node file operations and streams. Plugins can use ordinary filesystem features such as links with the host process's permissions.

`harnessFileAccess.open(root, options)` opens a confined directory view for consumer-supplied file paths. The optional `exclude` callback receives absolute paths. The view confines paths to the root, rejects link traversal and publishes writes atomically. It supports binary data and streams files to EOF. Workspace file features choose their own exclusions and limits.
