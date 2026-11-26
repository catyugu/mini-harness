import { DomainError } from '@mini-harness/platform/errors';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { ContextSettings } from '../shared/state.ts';

const fields = {
  autoCompact: Type.Boolean({ default: true }),
  triggerRatio: Type.Number({ default: 0.8, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  targetRatio: Type.Number({ default: 0.6, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  retainRatio: Type.Number({ default: 0.16, exclusiveMinimum: 0, exclusiveMaximum: 1 }),
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

const schema = Type.Object(fields, { additionalProperties: false });

function ratioIssue({ retainRatio, targetRatio, triggerRatio }: ContextSettings) {
  if (retainRatio >= targetRatio || targetRatio >= triggerRatio)
    return 'Use 0 < retain < target < trigger < 100%.';
}

export const Config = defineConfig(schema, (config) =>
  Check(schema, config) ? ratioIssue(config) : 'Invalid context settings',
);

export function validateSettings(value: unknown): ContextSettings {
  if (!Check(schema, value)) throw new DomainError('invalid_input', 'Invalid context settings');
  const issue = ratioIssue(value);
  if (issue) throw new DomainError('invalid_input', issue);
  return value;
}
