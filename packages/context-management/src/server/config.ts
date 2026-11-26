import { DomainError } from '@mini-harness/platform/errors';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defaultContextSettings, ratioIssue, type ContextSettings } from '../shared/state.ts';

const fields = {
  autoCompact: Type.Boolean({ default: defaultContextSettings.autoCompact }),
  triggerRatio: Type.Number({
    default: defaultContextSettings.triggerRatio,
    exclusiveMinimum: 0,
    exclusiveMaximum: 1,
  }),
  targetRatio: Type.Number({
    default: defaultContextSettings.targetRatio,
    exclusiveMinimum: 0,
    exclusiveMaximum: 1,
  }),
  retainRatio: Type.Number({
    default: defaultContextSettings.retainRatio,
    exclusiveMinimum: 0,
    exclusiveMaximum: 1,
  }),
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
    { default: defaultContextSettings.summaryModel },
  ),
};

const schema = Type.Object(fields, { additionalProperties: false });

export const Config = defineConfig(schema, (config) =>
  Check(schema, config) ? ratioIssue(config) : 'Invalid context settings',
);

export function validateSettings(value: unknown): ContextSettings {
  if (!Check(schema, value)) throw new DomainError('invalid_input', 'Invalid context settings');
  const issue = ratioIssue(value);
  if (issue) throw new DomainError('invalid_input', issue);
  return value;
}
