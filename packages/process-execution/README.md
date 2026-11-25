# Process execution

`harnessProcess.start(command, signal)` launches an executable with an argument list, working directory and optional environment. It returns writable `stdin`, readable `stdout` and `stderr`, and a `finished` promise for the exit status. Consumers own stream handling and may pass an abort signal for cancellation. The process plugin also cancels and drains its work on unload.

Shell owns its command timeout, output limits and output aggregation. It can use a command prepared by an optional Sandbox.
