import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Service, type Context } from 'mini-harness/cordis';
import {
  type ToolDefinition,
  type RegisteredTool,
  type ToolPort,
  type ToolFactory,
  type ToolSelection,
} from './api.ts';
interface ToolRegistration {
  name: string;
  resolve(selection: ToolSelection): RegisteredTool;
  visible(resourceId?: string): boolean;
}

export class ToolRegistry {
  private readonly tools = new ScopedLayers<ToolRegistration>();
  service(): ToolPort {
    const registry = this;
    return Service.track<ToolPort>({
      register(definition) {
        const context = Service.caller(this);
        return registry.register(definition, { context, scope: scopeOf(context) });
      },
      list: registry.list.bind(registry),
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
        const available = () => registry.selected(name, selection) === entry;
        return {
          ...tool,
          available,
          async execute(call, args, signal, update, context) {
            const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
            const execute = async (signal: AbortSignal) => {
              signal.throwIfAborted();
              if (!available()) throw new Error('Tool is no longer available: ' + name);
              return tool.execute(call, args, signal, update, context);
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

  list(selection: ToolSelection = {}) {
    selection = { ...selection };
    const names = new Set(
      this.tools
        .chain(selection.scope)
        .reverse()
        .flatMap((layer) => [...layer.keys()]),
    );
    const available: RegisteredTool[] = [];
    for (const name of names) {
      const selected = this.selected(name, selection);
      if (selected) available.push(selected.resolve(selection));
    }
    return available;
  }
}
