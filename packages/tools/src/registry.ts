import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Check, Errors } from 'typebox/value';
import { Service, type Context } from 'mini-harness/cordis';
import { findInstance } from '@mini-harness/plugin-api/instance';
import { isToolContent, type ToolDefinition, type ToolPort, type ToolRegistrationOptions } from './api.ts';
import type { ToolDecision } from './events.ts';
import type { ToolAccess, ToolPolicy } from './policy.ts';

interface ToolRegistration extends ToolAccess {
  bind(id: string, scope?: ScopeKey): ToolDefinition;
  visible(id: string): boolean;
}

export class ToolRegistry {
  private readonly tools = new ScopedLayers<ToolRegistration>();
  private readonly leases = new WeakMap<ToolDefinition, { id: string; scope?: ScopeKey; entry: ToolRegistration }>();

  constructor(
    private readonly decide?: (request: ToolDecision, scope?: ScopeKey) => Promise<'deny' | undefined>,
    private readonly authorize: ToolPolicy = () => true,
  ) {}

  service(): ToolPort {
    const registry = this;
    return Service.track<ToolPort>({
      register(definition, options) {
        const context = Service.caller(this);
        const scope = scopeOf(context);
        const bind = 'bind' in definition ? definition.bind : () => definition;
        return registry.registerBinding(definition.name, bind, { ...options, context, scope });
      },
      forSession: registry.forSession.bind(registry),
      isAvailable: registry.isAvailable.bind(registry),
      readOnlyRegistrations: this.readOnlyRegistrations.bind(this),
    });
  }

  registerBinding(
    name: string,
    bind: (id: string) => ToolDefinition,
    {
      visible,
      scope,
      context: owner,
      access,
    }: ToolRegistrationOptions & { context?: Context; scope?: ScopeKey } = {},
  ) {
    if (!toolNamePattern.test(name)) throw new Error('Invalid tool name: ' + name);
    const lifetime = new AbortController();
    const registry = this;
    const active = new Set<Promise<unknown>>();
    const signal = owner?.fiber.signal;
    const identity = owner && findInstance(owner);
    const expired = () => lifetime.signal.aborted || signal?.aborted === true;
    const entry: ToolRegistration = {
      name,
      readOnly: access === 'readOnly',
      pluginId: identity?.pluginId,
      visible: (id) => !expired() && (visible?.(id) ?? true),
      bind(id, scope) {
        const tool = bind(id);
        if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
        const assertAuthorized = () => {
          if (expired()) throw new Error('Tool is no longer available: ' + name);
          if (!registry.isAvailable(id, leased))
            throw new Error('Tool denied by conversation or plugin policy: ' + name);
        };
        const leased: ToolDefinition = {
          ...tool,
          async execute(call, args, signal, update, context) {
            assertAuthorized();
            const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
            const execute = async (signal: AbortSignal) => {
              signal.throwIfAborted();
              assertAuthorized();
              const inputs = structuredClone(args);
              if (!Check(tool.parameters, inputs)) {
                const issue = [...Errors(tool.parameters, inputs)][0];
                throw new Error(
                  'Invalid arguments for ' +
                    name +
                    (issue ? ': ' + issue.instancePath + ' ' + issue.message : ''),
                );
              }
              if (
                (await registry.decide?.({
                  sessionId: id,
                  tool: name,
                  callId: call,
                  arguments: inputs,
                  signal,
                }, scope)) === 'deny'
              )
                throw new Error('Tool denied by conversation or plugin policy: ' + name);
              signal.throwIfAborted();
              assertAuthorized();
              const result = await tool.execute(
                call,
                inputs,
                signal,
                update,
                context && { ...context, assertAuthorized },
              );
              if (!result || !isToolContent(result.content))
                throw new Error('Invalid result from tool: ' + name);
              return result;
            };
            const work = owner
              ? owner.fiber.run(execute, combined)
              : Promise.resolve().then(() => execute(combined));
            active.add(work);
            try {
              return await work;
            } finally {
              active.delete(work);
            }
          },
        };
        registry.leases.set(leased, { id, scope, entry });
        return leased;
      },
    };
    const remove = this.tools.add(scope, name, entry);
    return async () => {
      remove();
      lifetime.abort(new Error('Tool is no longer available: ' + name));
      await Promise.allSettled(active);
    };
  }

  private selected(id: string, name: string, scope?: ScopeKey) {
    for (const layer of this.tools.chain(scope)) {
      const candidate = layer.get(name);
      if (candidate?.visible(id)) return candidate;
    }
  }

  isAvailable(id: string, tool: ToolDefinition) {
    const lease = this.leases.get(tool);
    return (
      lease?.id === id &&
      this.selected(id, lease.entry.name, lease.scope) === lease.entry &&
      this.authorize(id, lease.entry)
    );
  }

  readOnlyRegistrations(pluginId: string): string[] {
    return [
      ...new Set(
        [...this.tools.values()]
          .filter((entry) => entry.pluginId === pluginId && entry.readOnly)
          .map(({ name }) => name),
      ),
    ].sort();
  }

  forSession(id: string, scope?: ScopeKey) {
    const names = new Set(this.tools.chain(scope).reverse().flatMap((layer) => [...layer.keys()]));
    const available: ToolDefinition[] = [];
    for (const name of names) {
      const selected = this.selected(id, name, scope);
      if (selected && this.authorize(id, selected)) available.push(selected.bind(id, scope));
    }
    return available;
  }
}
