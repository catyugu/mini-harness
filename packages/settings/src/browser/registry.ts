import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { PluginSettingsContribution, SettingsContribution, SettingsSection } from './api.ts';

interface Entry {
  sectionId: string;
  order: number;
  node: HTMLElement;
}

export class SettingsRegistry extends EventTarget {
  private readonly details = new Map<string, PluginSettingsContribution['render']>();

  registerPlugin(owner: string, { id, render }: PluginSettingsContribution) {
    const key = owner + '/' + id;
    if (this.details.has(key)) throw new Error('Duplicate plugin settings contribution: ' + key);
    this.details.set(key, render);
    this.dispatchEvent(new Event('plugin'));
    return () => {
      if (this.details.delete(key)) this.dispatchEvent(new Event('plugin'));
    };
  }

  mountPlugin(pluginId: string, container: HTMLElement, signal: AbortSignal) {
    const mounted = new Map<string, { lifetime: AbortController; node?: HTMLElement }>();
    const refresh = () => {
      for (const [key, { node, lifetime }] of mounted)
        if (!this.details.has(key)) {
          lifetime.abort();
          node?.remove();
          mounted.delete(key);
        }
      for (const [key, render] of this.details) {
        if (mounted.has(key)) continue;
        const lifetime = new AbortController();
        try {
          const node = render(pluginId, lifetime.signal);
          mounted.set(key, { lifetime, node });
          if (node) container.append(node);
        } catch (error) {
          lifetime.abort();
          console.error('Plugin settings contribution failed', error);
        }
      }
    };
    this.addEventListener('plugin', refresh, { signal });
    signal.addEventListener(
      'abort',
      () => {
        for (const { lifetime, node } of mounted.values()) {
          lifetime.abort();
          node?.remove();
        }
        mounted.clear();
      },
      { once: true },
    );
    refresh();
  }

  private readonly definitions = new Map<string, SettingsSection>();
  private readonly entries = new Map<string, Entry>();

  registerSection({ id, ...metadata }: SettingsSection, signal: AbortSignal) {
    if (!validId.test(id) || this.definitions.has(id))
      throw new Error('Invalid or duplicate settings section: ' + id);
    signal.throwIfAborted();
    const update = (next: Omit<SettingsSection, 'id'>) => {
      signal.throwIfAborted();
      if (!next.title.trim() || !Number.isFinite(next.order ?? 100))
        throw new Error('Invalid settings section metadata: ' + id);
      this.definitions.set(id, { ...next, id });
      this.dispatchEvent(new Event('change'));
    };
    update(metadata);
    signal.addEventListener(
      'abort',
      () => {
        this.definitions.delete(id);
        this.dispatchEvent(new Event('change'));
      },
      { once: true },
    );
    return update;
  }

  register(owner: string, contribution: SettingsContribution, configuration: PluginConfiguration) {
    const { id, sectionId, order = 0, render } = contribution;
    const key = owner + '/' + id;
    if (!validId.test(id) || !validId.test(sectionId) || !Number.isFinite(order))
      throw new Error('Invalid settings contribution: ' + key);
    if (this.entries.has(key)) throw new Error('Duplicate settings contribution: ' + key);
    const lifetime = new AbortController();
    const { signal } = lifetime;
    try {
      const node = render({
        signal,
        configuration,
        bind: (control, field, binding) => bindControl(configuration, signal, control, field, binding),
      });
      this.entries.set(key, { sectionId, order, node });
      this.dispatchEvent(new Event('change'));
    } catch (error) {
      lifetime.abort();
      throw error;
    }
    return () => {
      if (!this.entries.delete(key)) return;
      lifetime.abort();
      this.dispatchEvent(new Event('change'));
    };
  }

  sections() {
    const groups = new Map<string, HTMLElement[]>();
    const entries = [...this.entries].sort(
      ([a, first], [b, second]) => first.order - second.order || a.localeCompare(b),
    );
    for (const [, { sectionId, node }] of entries) {
      if (!this.definitions.has(sectionId)) continue;
      const nodes = groups.get(sectionId) ?? [];
      nodes.push(node);
      groups.set(sectionId, nodes);
    }
    return [...this.definitions.values()]
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id))
      .flatMap((section) => {
        const nodes = groups.get(section.id);
        return nodes ? [{ section, nodes }] : [];
      });
  }
}

const validId = /^[a-z][a-z0-9.-]{0,95}$/;

function bindControl<T>(
  configuration: PluginConfiguration,
  signal: AbortSignal,
  control: HTMLInputElement | HTMLSelectElement,
  key: string,
  binding: {
    read(value: T): void;
    write(): T;
  },
) {
  const status = document.createElement('p');
  status.className = 'hint form-error';
  status.setAttribute('role', 'alert');
  const sync = () => binding.read(configuration.get<T>(key));
  sync();
  const unsubscribe = configuration.subscribe<T>(key, (value) => {
    if (!control.disabled) binding.read(value);
  });
  signal.addEventListener('abort', unsubscribe, { once: true });
  control.addEventListener(
    'change',
    async () => {
      if (control.disabled) return;
      control.disabled = true;
      control.setAttribute('aria-busy', 'true');
      status.textContent = '';
      try {
        await configuration.set(key, binding.write());
      } catch (error) {
        if (!signal.aborted) status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        if (!signal.aborted) {
          sync();
          control.disabled = false;
          control.removeAttribute('aria-busy');
        }
      }
    },
    { signal },
  );
  return status;
}
