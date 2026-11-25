import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';

export function entryAddress(entryId: string) {
  const slash = entryId.indexOf('/');
  return {
    id: entryId.slice(slash + 1),
    scope: slash < 0 ? undefined : (entryId.slice(0, slash) as ScopeAddress),
  };
}
