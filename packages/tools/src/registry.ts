import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Check, Errors } from 'typebox/value';
import { Service, type Context } from 'mini-harness/cordis';
import { agentScopeOf, findInstance, sessionVisible } from '@mini-harness/plugin-api/instance';
import { isToolContent, type ToolDefinition, type ToolPort, type ToolRegistrationOptions } from './api.ts';
import type { ToolInvocation, ToolPreparation } from './events.ts';
import type { ToolAccess, ToolPolicy } from './policy.ts';

interface ToolRegistration extends ToolAccess {
  scope?: ScopeKey;
  bind(id: string): ToolDefinition;
  visible(id: string): boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();
  private readonly leases = new WeakMap<ToolDefinition, { id: string; entry: ToolRegistration }>();

  constructor(
    private readonly address: (id: string) => readonly ScopeKey[] = () => [],
    private readonly prepare?: (request: ToolInvocation) => Promise<ToolPreparation>,
    private readonly authorize: ToolPolicy = () => true,
    private readonly hasPreparation: (id: string) => boolean = () => Boolean(prepare),
  ) {}

  service(): ToolPort {
    const registry = this;
    const visibleToCaller = (service: ToolPort, id: string) => {
      const caller = Service.caller(service);
      return !caller.fiber.runtime || sessionVisible(caller, id);
    };
    return Service.track<ToolPort>({
      register(definition, options) {
        const context = Service.caller(this);
        const scopeKey = agentScopeOf(context) ?? findInstance(context)?.scopeKey;
        const bind = 'bind' in definition ? definition.bind : () => definition;
        return registry.registerBinding(definition.name, bind, { ...options, context, scope: scopeKey });
      },
      forSession(id) {
        return visibleToCaller(this, id) ? registry.forSession(id) : [];
      },
      isAvailable(id, tool) {
        return visibleToCaller(this, id) && registry.isAvailable(id, tool);
      },
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
    const runScope = owner && agentScopeOf(owner);
    const key = (runScope ? 'agent/' + runScope : (scope ?? '')) + '/' + name;
    if (this.tools.has(key)) throw new Error('Duplicate tool in scope: ' + name);
    const lifetime = new AbortController();
    const registry = this;
    const active = new Set<Promise<unknown>>();
    const signal = owner?.fiber.signal;
    const expired = () => lifetime.signal.aborted || signal?.aborted === true;
    const entry: ToolRegistration = {
      name,
      scope,
      readOnly: access === 'readOnly',
      visible: (id) =>
        !expired() && (!scope || registry.address(id).includes(scope)) && (visible?.(id) ?? true),
      bind(id) {
        const tool = bind(id);
        if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
        const assertAuthorized = () => {
          if (expired()) throw new Error('Tool is no longer available: ' + name);
          if (!registry.isAvailable(id, leased))
            throw new Error('Tool denied by conversation or plugin policy: ' + name);
        };
        const leased: ToolDefinition = {
          ...tool,
          isConcurrencySafe: tool.isConcurrencySafe
            ? (args) => !registry.hasPreparation(id) && tool.isConcurrencySafe!(args)
            : undefined,
          async execute(call, args, signal, update, context) {
            assertAuthorized();
            const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
            const execute = async (signal: AbortSignal) => {
              signal.throwIfAborted();
              assertAuthorized();
              let inputs = structuredClone(args);
              const validate = (value: Record<string, unknown>) => {
                if (Check(tool.parameters, value)) return;
                const issue = [...Errors(tool.parameters, value)][0];
                throw new Error(
                  'Invalid arguments for ' +
                    name +
                    (issue ? ': ' + issue.instancePath + ' ' + issue.message : ''),
                );
              };
              validate(inputs);
              const prepared = await registry.prepare?.({
                sessionId: id,
                tool: name,
                callId: call,
                arguments: structuredClone(inputs),
                signal,
              });
              if (prepared === 'deny') throw new Error('Tool denied by conversation or plugin policy: ' + name);
              if (prepared !== undefined) {
                const next = structuredClone(prepared.arguments);
                validate(next);
                if (tool.isConcurrencySafe?.(inputs) && !tool.isConcurrencySafe(next))
                  throw new Error('Tool preparation cannot turn a parallel-safe call into a serial call: ' + name);
                inputs = next;
              }
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
        registry.leases.set(leased, { id, entry });
        return leased;
      },
    };
    this.tools.set(key, entry);
    return async () => {
      if (this.tools.get(key) === entry) this.tools.delete(key);
      lifetime.abort(new Error('Tool is no longer available: ' + name));
      await Promise.allSettled(active);
    };
  }

  private selected(id: string, name: string) {
    for (const scope of [...this.address(id)].reverse()) {
      const local = this.tools.get('agent/' + scope + '/' + name);
      if (local?.visible(id)) return local;
      const candidate = this.tools.get(scope + '/' + name);
      if (candidate?.visible(id)) return candidate;
    }
    const candidate = this.tools.get('/' + name);
    if (candidate?.visible(id)) return candidate;
  }

  isAvailable(id: string, tool: ToolDefinition) {
    const lease = this.leases.get(tool);
    return (
      lease?.id === id &&
      this.selected(id, lease.entry.name) === lease.entry &&
      this.authorize(id, lease.entry)
    );
  }

  forSession(id: string) {
    const names = new Set([...this.tools.values()].map(({ name }) => name));
    const available: ToolDefinition[] = [];
    for (const name of names) {
      const selected = this.selected(id, name);
      if (selected && this.authorize(id, selected)) available.push(selected.bind(id));
    }
    return available;
  }
}
