import type { ScopeKey, ScopeSettings } from './scopes.ts';
import { Check } from 'typebox/value';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Configuration of one Cordis Entry, indexed by its stable ID in a Profile. */
export interface EntryConfiguration {
  name?: string;
  client?: boolean;
  disabled?: boolean;
  live?: boolean;
  config?: Record<string, unknown>;
}

export interface CompositionConfig {
  entries: Record<string, EntryConfiguration>;
  scopes: Partial<Record<ScopeKey, ScopeSettings>>;
}

export type ProfileConfiguration = CompositionConfig;

export function scopeKeys(configuration: CompositionConfig) {
  return Object.keys(configuration.scopes) as ScopeKey[];
}

/** A synchronous native Cordis schema backed by JSON Schema, also usable by configuration forms. */
export function defineConfig(
  schema: Record<string, any>,
  refine?: (config: Readonly<Record<string, unknown>>) => string | undefined,
): StandardSchemaV1<unknown, Record<string, unknown>> & { jsonSchema: Record<string, any> } {
  return {
    jsonSchema: schema,
    '~standard': {
      version: 1,
      vendor: 'mini-harness',
      validate(value) {
        const candidate = configDefaults(schema, structuredClone(value ?? {}));
        if (
          !Check(schema, candidate) ||
          !candidate ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate)
        )
          return { issues: [{ message: 'Invalid configuration' }] };
        const config = candidate as Record<string, unknown>;
        const issue = refine?.(config);
        return issue ? { issues: [{ message: issue }] } : { value: config };
      },
    },
  };
}

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!property || typeof property !== 'object' || Array.isArray(property))
        throw new Error('Invalid plugin config property');
      const item = configDefaults(
        property as Record<string, unknown>,
        Object.hasOwn(value, key) ? value[key] : undefined,
      );
      if (item !== undefined)
        Object.defineProperty(value, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  return value;
}
