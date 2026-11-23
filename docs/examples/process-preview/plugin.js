export default function setup(_ctx, api) {
  api.provide('harnessProcess', {
    async run({ command, cwd, signal }) {
      signal?.throwIfAborted();
      return { code: 0, signal: null, stdout: '[' + cwd + '] ' + command, stderr: '', truncated: false };
    }
  });
}
