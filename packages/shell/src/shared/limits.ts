export const shellLimits = {
  timeoutMs: {
    title: 'Command timeout (ms)',
    description: 'Default command timeout. Agents may override it for individual commands.',
    minimum: 1,
    maximum: 86400000,
    default: 120000,
  },
  maxOutputBytes: {
    title: 'Output limit per stream (bytes)',
    description: 'Additional output is saved to a temporary file.',
    minimum: 1,
    maximum: 1048576,
    default: 64000,
  },
};
