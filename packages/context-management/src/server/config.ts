import { DomainError } from '@mini-harness/platform/errors';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import type { ContextSettings } from '../shared/state.ts';

const fields = {
  autoCompact: Type.Boolean({ default: true }),
  triggerRatio: Type.Number({ default: 0.8, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  targetRatio: Type.Number({ default: 0.6, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  retainRatio: Type.Number({ default: 0.16, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  pruneTools: Type.Boolean({ default: true }),
  summaryModel: Type.Union(
    [
      Type.Null(),
      Type.Object(
        {
          provider: Type.String({ minLength: 1, maxLength: 160 }),
          id: Type.String({ minLength: 1, maxLength: 160 }),
        },
        { additionalProperties: false },
      ),
    ],
    { default: null },
  ),
};

export const Config = defineConfig(Type.Object(fields, { additionalProperties: false }), (config) => {
  const { retainRatio, targetRatio, triggerRatio } = config as unknown as ContextSettings;
  if (retainRatio >= targetRatio || targetRatio >= triggerRatio)
    return 'Use 0 < retain < target < trigger < 100%.';
});

export function resolveSettings(defaults: ContextSettings, overrides: unknown): ContextSettings {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new DomainError('invalid_input', 'Expected a context settings object');
  const config = Config['~standard'].validate({ ...defaults, ...overrides });
  if (config instanceof Promise || config.issues)
    throw new DomainError(
      'invalid_input',
      config instanceof Promise
        ? 'Invalid context settings'
        : (config.issues[0]?.message ?? 'Invalid context settings'),
    );
  return config.value as unknown as ContextSettings;
}
