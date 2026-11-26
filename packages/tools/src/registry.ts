import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';
import { Service, type Context } from 'mini-harness/cordis';
import { bindTool } from './invocation.ts';
import { type ToolDefinition, type ToolPort, type ToolFactory, type ToolSelection } from './api.ts';
interface ToolRegistration {
  name: string;
  resolve(selection: ToolSelection, caller?: Context): ToolDefinition;
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
      list(selection) {
        const caller = Service.caller(this);
        return registry.list({ scope: scopeOf(caller), ...selection }, caller);
      },
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
    const active = new Set<Promise<unknown>>();
    const registry = this;
    const unavailable = () => new Error('Tool is no longer available: ' + name);
    const expired = () => lifetime.signal.aborted || owner?.fiber.signal.aborted === true;
    const entry: ToolRegistration = {
      name,
      visible: (resourceId) =>
        !expired() && (!factory || (resourceId !== undefined && (factory.visible?.(resourceId) ?? true))),
      resolve(selection, caller) {
        const resolve = (context?: Context) => {
          const tool = factory
            ? factory.resolve(selection.resourceId!, context ?? caller)
            : (definition as ToolDefinition);
          if (tool.name !== name) throw new Error('Tool binding changed its registered name: ' + name);
          return tool;
        };
        return bindTool(resolve(), {
          provider: owner,
          signal: lifetime.signal,
          track(work) {
            active.add(work);
            const done = () => active.delete(work);
            void work.then(done, done);
          },
          available: () => registry.selected(name, selection) === entry,
          resolve,
        });
      },
    };
    const remove = this.tools.add(scope, name, entry);
    return async () => {
      remove();
      lifetime.abort(new DOMException(unavailable().message, 'AbortError'));
      await Promise.allSettled(active);
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
    const available: ToolDefinition[] = [];
    for (const name of names) {
      const selected = this.selected(name, selection);
      if (selected) available.push(selected.resolve(selection, caller));
    }
    return available;
  }
}
