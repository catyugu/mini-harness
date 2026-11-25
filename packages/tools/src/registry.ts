import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Check, Errors } from 'typebox/value';
import { Service, type Context } from 'mini-harness/cordis';
import {
  isToolContent,
  type ToolDefinition,
  type ToolPort,
  type ToolFactory,
  type ToolSelection,
} from './api.ts';
interface ToolRegistration {
  name: string;
  resolve(selection: ToolSelection): ToolDefinition;
  visible(resourceId?: string): boolean;
}

export class ToolRegistry {
  private readonly tools = new ScopedLayers<ToolRegistration>();
  private readonly leases = new WeakMap<
    ToolDefinition,
    { selection: ToolSelection; entry: ToolRegistration }
  >();

  service(): ToolPort {
    const registry = this;
    return Service.track<ToolPort>({
      register(definition) {
        const context = Service.caller(this);
        return registry.register(definition, { context, scope: scopeOf(context) });
      },
      list: registry.list.bind(registry),
      isAvailable: registry.isAvailable.bind(registry),
    });
  }

  register(
    definition: ToolDefinition | ToolFactory,
    { context: owner, scope }: { context?: Context; scope?: ScopeKey } = {},
  ) {
    const { name } = definition;
    const factory = 'resolve' in definition ? definition : undefined;
    if (!toolNamePattern.test(name)) throw new Error('Invalid tool name: ' + name);
    const lifetime = new AbortController();
    const registry = this;
    const active = new Set<Promise<unknown>>();
    const signal = owner?.fiber.signal;
    const expired = () => lifetime.signal.aborted || signal?.aborted === true;
    const entry: ToolRegistration = {
      name,
      visible: (resourceId) =>
        !expired() && (!factory || (resourceId !== undefined && (factory.visible?.(resourceId) ?? true))),
      resolve(selection) {
        const tool = 'resolve' in definition ? definition.resolve(selection.resourceId!) : definition;
        if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
        const assertAvailable = () => {
          if (!registry.isAvailable(leased)) throw new Error('Tool is no longer available: ' + name);
        };
        const leased: ToolDefinition = {
          ...tool,
          async execute(call, args, signal, update, context) {
            assertAvailable();
            const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
            const execute = async (signal: AbortSignal) => {
              signal.throwIfAborted();
              assertAvailable();
              const inputs = args;
              if (!Check(tool.parameters, inputs)) {
                const issue = [...Errors(tool.parameters, inputs)][0];
                throw new Error(
                  'Invalid arguments for ' +
                    name +
                    (issue ? ': ' + issue.instancePath + ' ' + issue.message : ''),
                );
              }
              const result = await tool.execute(call, inputs, signal, update, context);
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
        registry.leases.set(leased, { selection, entry });
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

  private selected(name: string, { scope, resourceId }: ToolSelection) {
    for (const layer of this.tools.chain(scope)) {
      const candidate = layer.get(name);
      if (candidate?.visible(resourceId)) return candidate;
    }
  }

  isAvailable(tool: ToolDefinition) {
    const lease = this.leases.get(tool);
    return !!lease && this.selected(lease.entry.name, lease.selection) === lease.entry;
  }

  list(selection: ToolSelection = {}) {
    selection = { ...selection };
    const names = new Set(
      this.tools
        .chain(selection.scope)
        .reverse()
        .flatMap((layer) => [...layer.keys()]),
    );
    const available: ToolDefinition[] = [];
    for (const name of names) {
      const selected = this.selected(name, selection);
      if (selected) available.push(selected.resolve(selection));
    }
    return available;
  }
}
