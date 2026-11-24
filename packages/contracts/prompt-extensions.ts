import { extension, type ContributionSource } from './contributions.js';
import type { ToolDefinition } from './tools.js';

export interface PromptContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  tools: readonly Omit<ToolDefinition, 'execute' | 'isConcurrencySafe'>[];
}
export interface PromptSection {
  id: string;
  order?: number;
  render(context: PromptContext): string | undefined | Promise<string | undefined>;
}

export interface ScopedPromptSection extends PromptSection {
  depth: number;
  pluginId: string;
}

const sectionsBySource = new WeakMap<ContributionSource, Set<string>>();

export const promptExtensions = {
  section: extension((source, { id, order = 500, render }: PromptSection) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(id) || !Number.isFinite(order) || typeof render !== 'function')
      throw new Error('Invalid prompt section: ' + id);
    const sections = sectionsBySource.get(source) ?? new Set<string>();
    if (sections.has(id)) throw new Error('Duplicate prompt section: ' + id);
    sections.add(id);
    sectionsBySource.set(source, sections);
    let registered = true;
    const unregister = source.context.on('harness/prompt-sections', (sessionId, items) => {
      if (!source.visible(sessionId)) return;
      items.push({ id, order, depth: source.depth(sessionId), pluginId: source.instanceId,
        render({ signal, ...input }) {
          return source.run('prompt section ' + id, async (signal) => {
            if (!registered) throw new Error('Prompt section is no longer registered');
            const text = await render({ ...structuredClone(input), signal });
            if (!registered) throw new Error('Prompt section is no longer registered');
            if (text !== undefined && typeof text !== 'string') throw new Error('Invalid prompt section output');
            return text;
          }, signal);
        } });
    });
    return () => { registered = false; sections.delete(id); unregister(); };
  })
};

declare module 'cordis' {
  interface Events {
    'harness/prompt-sections'(sessionId: string, sections: ScopedPromptSection[]): void;
  }
}
