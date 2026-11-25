import { defineConfig } from 'mini-harness/configuration';

export const Config = defineConfig({
  type: 'object',
  properties: {
    replaceComposer: {
      type: 'boolean',
      default: false,
    },
  },
  additionalProperties: false,
});
