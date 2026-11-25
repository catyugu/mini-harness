import type { Context } from 'mini-harness/cordis';
import { scopeTarget, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { ToolDefinition, ToolPort } from '@mini-harness/tools/api';

interface ConversationTool extends ToolDefinition {
  available(): boolean;
}

/** Conversation policy belongs to the consumer of the selected tool leases. */
export function conversationTools(
  ctx: Context,
  sessionId: string,
  scope?: ScopeKey,
  registry: ToolPort = ctx.harnessTools,
) {
  const allowed = (tool: ToolDefinition) => ctx.get('harnessToolPolicy')?.(sessionId, tool) ?? true;
  const denied = (tool: ToolDefinition) =>
    new Error('Tool denied by conversation or plugin policy: ' + tool.name);

  return registry
    .list({ scope, resourceId: sessionId })
    .filter(allowed)
    .map(
      (tool): ConversationTool => ({
        ...tool,
        async execute(callId, args, signal, update, context) {
          const assertAuthorized = () => {
            if (!allowed(tool)) throw denied(tool);
          };
          const input = { sessionId, tool: tool.name, callId, arguments: args };
          for (const { context: owner, callback } of ctx.events.listeners(
            'agent/tool-decision',
            scopeTarget(ctx, scope),
          )) {
            const decision = await owner.fiber.run((signal) => callback({ ...input, signal }), signal);
            if (decision === undefined) continue;
            if (decision === 'deny') throw denied(tool);
            throw new Error('Invalid tool policy decision');
          }
          signal?.throwIfAborted();
          assertAuthorized();
          return tool.execute(callId, args, signal, update, context && { ...context, assertAuthorized });
        },
        // Preserve the selected lease when the caller rechecks the advertised list.
        available: () => tool.available() && allowed(tool),
      }),
    );
}
