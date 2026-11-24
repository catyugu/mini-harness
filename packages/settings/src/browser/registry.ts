import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { PluginSettingsContribution, SettingsContribution, SettingsSection } from './api.js';

interface Entry {
  section: SettingsContribution['section'];
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
    return () => { if (this.details.delete(key)) this.dispatchEvent(new Event('plugin')); };
  }

  mountPlugin(pluginId: string, container: HTMLElement, signal: AbortSignal) {
    const mounted = new Map<string, { lifetime: AbortController; node?: HTMLElement }>();
    const refresh = () => {
      for (const [key, { node, lifetime }] of mounted) if (!this.details.has(key)) {
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
    signal.addEventListener('abort', () => {
      for (const { lifetime, node } of mounted.values()) { lifetime.abort(); node?.remove(); }
      mounted.clear();
    }, { once: true });
    refresh();
  }

  private readonly entries = new Map<string, Entry>();

  register(owner: string, contribution: SettingsContribution, configuration: PluginConfiguration) {
    const { id, section, order = 0, render } = contribution;
    const title = typeof section === 'string' ? section : section.title;
    const key = owner + '/' + id;
    if (!title.trim() || !/^[a-z][a-z0-9.-]{0,95}$/.test(id) || !Number.isFinite(order) ||
      (typeof section !== 'string' && section.order !== undefined && !Number.isFinite(section.order)))
      throw new Error('Invalid settings contribution: ' + key);
    if (this.entries.has(key)) throw new Error('Duplicate settings contribution: ' + key);
    const lifetime = new AbortController();
    const { signal } = lifetime;
    try {
      const node = render({
        signal, configuration,
        bind: (control, field, binding) => bindControl(configuration, signal, control, field, binding),
      });
      this.entries.set(key, { section, order, node });
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
    const groups = new Map<string, { section: SettingsSection; nodes: HTMLElement[] }>();
    const entries = [...this.entries].sort(([a, first], [b, second]) => first.order - second.order || a.localeCompare(b));
    for (const [, entry] of entries) {
      const section = typeof entry.section === 'string' ? { title: entry.section } : entry.section;
      let group = groups.get(section.title);
      if (!group) {
        group = { section, nodes: [] };
        groups.set(section.title, group);
      }
      if ((section.order ?? Infinity) < (group.section.order ?? Infinity)) group.section = section;
      group.nodes.push(entry.node);
    }
    return [...groups.values()].sort(({ section: a }, { section: b }) =>
      (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  }
}

function bindControl<T>(configuration: PluginConfiguration, signal: AbortSignal,
  control: HTMLInputElement | HTMLSelectElement, key: string, binding: {
    read(value: T): void;
    write(): T;
  }) {
  const status = document.createElement('p');
  status.className = 'hint form-error';
  status.setAttribute('role', 'alert');
  const sync = () => binding.read(configuration.get<T>(key));
  sync();
  const unsubscribe = configuration.subscribe<T>(key, (value) => { if (!control.disabled) binding.read(value); });
  signal.addEventListener('abort', unsubscribe, { once: true });
  control.addEventListener('change', async () => {
    if (control.disabled) return;
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    status.textContent = '';
    try { await configuration.set(key, binding.write()); }
    catch (error) {
      if (!signal.aborted) status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (!signal.aborted) {
        sync();
        control.disabled = false;
        control.removeAttribute('aria-busy');
      }
    }
  }, { signal });
  return status;
}
