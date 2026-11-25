import type { Context } from 'mini-harness/cordis';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';

export function conversationTools(ctx: Context, sessionId: string, scope?: ScopeKey) {
  const tools = ctx.get('harnessTools');
  if (!tools) throw new Error('Required service is unavailable: harnessTools');
  const policy = ctx.get('harnessToolPolicy');
  return tools
    .list({ resourceId: sessionId, ...(scope && { scope }) })
    .filter((tool) => policy?.(sessionId, tool) ?? true);
}
