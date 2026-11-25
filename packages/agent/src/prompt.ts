import { Service, type Context } from 'mini-harness/cordis';
import { agentScopeOf, findInstance, sessionAddress } from '@mini-harness/plugin-api/instance';
import type { PromptPort, PromptContext, PromptSection } from './prompt-api.ts';

export class Prompt implements PromptPort {
  private readonly sections = new Map<string, { context: Context; section: PromptSection }>();

  register(section: PromptSection) {
    const context = Service.caller(this);
    const instanceId = context.fiber.uid;
    const { id, order = 500, priority = 0, render } = section;
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(id) ||
      !Number.isFinite(order) ||
      !Number.isFinite(priority) ||
      typeof render !== 'function'
    )
      throw new Error('Invalid prompt section: ' + id);
    const key = instanceId + '/' + id;
    if (this.sections.has(key)) throw new Error('Duplicate prompt section: ' + id);
    const scope = (ctx: Context) => agentScopeOf(ctx) ?? findInstance(ctx)?.scopeKey;
    const isRun = Boolean(agentScopeOf(context));
    for (const { context: other, section: existing } of this.sections.values()) {
      if (
        !other.fiber.signal.aborted &&
        existing.id === id &&
        (existing.priority ?? 0) === priority &&
        Boolean(agentScopeOf(other)) === isRun &&
        scope(other) === scope(context)
      )
        throw new Error('Conflicting prompt section: ' + id);
    }
    this.sections.set(key, { context, section: { id, order, priority, render } });
    return () => {
      this.sections.delete(key);
    };
  }

  async build(context: PromptContext) {
    const contributed = [...this.sections.values()].flatMap(({ context: owner, section }) => {
      if (owner.fiber.signal.aborted) return [];
      const runScope = agentScopeOf(owner);
      const identity = findInstance(owner);
      const scopeKey = runScope ?? identity?.scopeKey;
      const address = sessionAddress(owner, context.sessionId);
      if (scopeKey && !address.includes(scopeKey)) return [];
      return [
        {
          ...section,
          depth: (scopeKey ? 2 * (address.indexOf(scopeKey) + 1) : 0) + (runScope ? 1 : 0),
          render: ({ signal, ...input }: PromptContext) =>
            owner.fiber.run((signal) => section.render({ ...structuredClone(input), signal }), signal),
        },
      ];
    });
    const sections = new Map<string, PromptSection & { depth: number }>();
    for (const section of contributed) {
      const current = sections.get(section.id);
      if (
        !current ||
        section.depth > current.depth ||
        (section.depth === current.depth && (section.priority ?? 0) > (current.priority ?? 0))
      )
        sections.set(section.id, section);
    }
    const parts: string[] = [];
    for (const section of [...sections.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    )) {
      context.signal.throwIfAborted();
      const text = await section.render(context);
      if (text !== undefined && typeof text !== 'string')
        throw new Error('Invalid prompt section output: ' + section.id);
      if (text?.trim()) parts.push(text);
    }
    return parts.join('\n\n');
  }
}
