import { Check, Errors } from 'typebox/value';
import { isTrustedContribution } from '@mini-harness/contracts/contributions';
import { isToolContent, type ToolDefinition, type ToolPort } from '@mini-harness/contracts/tools';
import type { ToolDecision } from '@mini-harness/contracts/events';

interface ToolRegistration {
  name: string;
  scope?: string;
  readOnly: boolean;
  bind(id: string): ToolDefinition;
  visible(id: string): boolean;
}

export class ToolRegistry implements ToolPort {
  private readonly tools = new Map<string, ToolRegistration>();
  private readonly leases = new WeakMap<ToolDefinition, { id: string; entry: ToolRegistration }>();

  constructor(private readonly address: (id: string) => readonly string[] = () => [],
    private readonly decide?: (request: ToolDecision) => Promise<'deny' | undefined>,
    private readonly restrictions: (id: string) => { readOnly: boolean; disabledTools: string[] } = () => ({
      readOnly: false, disabledTools: []
    })) {}

  register(name: string, bind: (id: string) => ToolDefinition,
    { visible, scope, source, access }: NonNullable<Parameters<ToolPort['register']>[2]> = {}) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid tool name: ' + name);
    const key = (scope ?? '') + '/' + name;
    if (this.tools.has(key)) throw new Error('Duplicate tool in scope: ' + name);
    const lifetime = new AbortController();
    const registry = this;
    const active = new Set<Promise<unknown>>();
    const expired = () => lifetime.signal.aborted || source?.signal.aborted === true;
    const entry: ToolRegistration = { name, scope, readOnly: access === 'readOnly' && !!source && isTrustedContribution(source),
      visible: (id) => !expired() && (source?.visible(id) ?? true) && (visible?.(id) ?? true),
      bind(id) {
        const tool = bind(id);
        if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
        const assertAuthorized = () => {
          if (expired()) throw new Error('Tool is no longer available: ' + name);
          if (!registry.isAvailable(id, leased)) throw new Error('Tool denied by conversation or plugin policy: ' + name);
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
                throw new Error('Invalid arguments for ' + name + (issue ? ': ' + issue.instancePath + ' ' + issue.message : ''));
              }
              if (await registry.decide?.({ sessionId: id, tool: name, callId: call, arguments: inputs, signal }) === 'deny')
                throw new Error('Tool denied by conversation or plugin policy: ' + name);
              signal.throwIfAborted();
              assertAuthorized();
              const result = await tool.execute(call, inputs, signal, update, context && { ...context, assertAuthorized });
              if (!result || !isToolContent(result.content)) throw new Error('Invalid result from tool: ' + name);
              return result;
            };
            const work = source ? source.run('tool ' + name, execute, combined) : Promise.resolve().then(() => execute(combined));
            active.add(work);
            try { return await work; }
            finally { active.delete(work); }
          }
        };
        registry.leases.set(leased, { id, entry });
        return leased;
      }
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
      const candidate = this.tools.get(scope + '/' + name);
      if (candidate?.visible(id)) return candidate;
    }
    const candidate = this.tools.get('/' + name);
    if (candidate?.visible(id)) return candidate;
  }

  private allowed(id: string, { name, readOnly }: ToolRegistration) {
    const policy = this.restrictions(id);
    return !policy.disabledTools.includes(name) && (!policy.readOnly || readOnly);
  }

  isAvailable(id: string, tool: ToolDefinition) {
    const lease = this.leases.get(tool);
    return lease?.id === id && this.selected(id, lease.entry.name) === lease.entry && this.allowed(id, lease.entry);
  }

  forSession(id: string) {
    const names = new Set([...this.tools.values()].map(({ name }) => name));
    const available: ToolDefinition[] = [];
    for (const name of names) {
      const selected = this.selected(id, name);
      if (selected && this.allowed(id, selected)) available.push(selected.bind(id));
    }
    return available;
  }
}
