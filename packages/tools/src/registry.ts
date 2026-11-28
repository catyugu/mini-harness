import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Service, type Context } from 'mini-harness/cordis';
import { type ToolDefinition, type ResolvedTool, type ToolPort, type ToolFactory, type ToolSelection } from './api.ts';
interface ToolRegistration {
  name: string;
  resolve(selection: ToolSelection, caller?: Context): ResolvedTool;
  visible(resourceId?: string): boolean;
}

export class ToolRegistry {
  private readonly tools = new ScopedLayers<ToolRegistration>();

  service(): ToolPort {
    const registry = this;
    return Service.track<ToolPort>({
      register(definition, provider) {
        const caller = Service.caller(this);
        return registry.register(definition, { context: provider ?? caller, scope: scopeOf(caller) });
      },
      list(selection) {
        const caller = Service.caller(this);
        return registry.list({ scope: scopeOf(caller), ...selection }, caller);
      },
    });
  }

  register(
    definition: ToolDefinition | ToolFactory,
    { context: owner, scope }: { context: Context; scope?: ScopeKey },
  ) {
    const { name } = definition;
    const factory = 'resolve' in definition ? definition : undefined;
    if (!toolNamePattern.test(name)) throw new Error('Invalid tool name: ' + name);
    const lifetime = new AbortController();
    const activation = owner.fiber.signal;
    const registry = this;
    const expired = () => lifetime.signal.aborted || activation.aborted;
    const entry: ToolRegistration = {
      name,
      visible: (resourceId) =>
        !expired() && (!factory || (resourceId !== undefined && (factory.visible?.(resourceId) ?? true))),
      resolve(selection, caller) {
        const tool = factory
          ? factory.resolve(selection.resourceId!, caller)
          : (definition as ToolDefinition);
        if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
        return {
          ...tool,
          binding: {
            provider: owner,
            signal: lifetime.signal,
            available: () => registry.selected(name, selection) === entry,
          },
        };
      },
    };
    const remove = this.tools.add(scope, name, entry);
    return () => {
      remove();
      lifetime.abort(new DOMException('Tool is no longer available: ' + name, 'AbortError'));
    };
  }

  private selected(name: string, { scope, resourceId }: ToolSelection) {
    for (const layer of this.tools.chain(scope)) {
      const candidate = layer.get(name);
      if (candidate?.visible(resourceId)) return candidate;
    }
  }

  list(selection: ToolSelection = {}, caller?: Context) {
    selection = { ...selection };
    const names = new Set(
      this.tools
        .chain(selection.scope)
        .reverse()
        .flatMap((layer) => [...layer.keys()]),
    );
    const available: ResolvedTool[] = [];
    for (const name of names) {
      const selected = this.selected(name, selection);
      if (selected) available.push(selected.resolve(selection, caller));
    }
    return available;
  }
}
