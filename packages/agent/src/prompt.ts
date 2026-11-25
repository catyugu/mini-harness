import { Service, type Context } from 'mini-harness/cordis';
import { ScopedLayers, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { PromptPort, PromptContext, PromptSection } from './prompt-api.ts';

export class Prompt implements PromptPort {
  private readonly sections = new ScopedLayers<{ context: Context; section: PromptSection }>();

  register(section: PromptSection) {
    const context = Service.caller(this);
    const { id, order = 500, priority = 0, render } = section;
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(id) ||
      !Number.isFinite(order) ||
      !Number.isFinite(priority) ||
      typeof render !== 'function'
    )
      throw new Error('Invalid prompt section: ' + id);
    return this.sections.add(scopeOf(context), context.fiber.uid + '/' + id, {
      context,
      section: { id, order, priority, render },
    });
  }

  async build(context: PromptContext, scope?: ScopeKey) {
    const sections = new Map<string, { context: Context; section: PromptSection }>();
    for (const layer of this.sections.chain(scope)) {
      const candidates = [...layer.values()].filter(
        ({ context, section }) => !context.fiber.signal.aborted && !sections.has(section.id),
      );
      candidates.sort((a, b) => (b.section.priority ?? 0) - (a.section.priority ?? 0));
      for (const item of candidates) {
        const current = sections.get(item.section.id);
        if (!current) sections.set(item.section.id, item);
        else if (current.section.priority === item.section.priority)
          throw new Error('Conflicting prompt section priority: ' + item.section.id);
      }
    }
    const parts: string[] = [];
    for (const { context: owner, section } of [...sections.values()].sort(
      (a, b) => (a.section.order ?? 0) - (b.section.order ?? 0) || a.section.id.localeCompare(b.section.id),
    )) {
      context.signal.throwIfAborted();
      const { signal, ...input } = context;
      const text = await owner.fiber.run(
        (signal) => section.render({ ...structuredClone(input), signal }),
        signal,
      );
      if (text !== undefined && typeof text !== 'string')
        throw new Error('Invalid prompt section output: ' + section.id);
      if (text?.trim()) parts.push(text);
    }
    return parts.join('\n\n');
  }
}
