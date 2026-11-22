import type { Contribution } from './contributions.js';
import type { FrontendApi, FrontendServices } from './extensions.js';

type Region = Parameters<FrontendApi['contributions']>[0];

function watchRegion<T>(api: FrontendApi, services: FrontendServices, region: Region, render: (entries: Contribution<T>[]) => void) {
  let scope = JSON.stringify(services.workspace());
  const refresh = () => { if (!api.signal.aborted) render(api.contributions<T>(region)); };
  api.watchContributions((changed) => { if (changed === region) refresh(); });
  services.onConversationChange(() => {
    const next = JSON.stringify(services.workspace());
    if (scope === next) return;
    scope = next;
    refresh();
  }, api.signal);
  refresh();
}

export function mountOutlet(api: FrontendApi, services: FrontendServices, region: Region, container: HTMLElement) {
  let nodes: HTMLElement[] = [];
  watchRegion<HTMLElement>(api, services, region, (entries) => {
    const next = entries.map(({ value }) => value);
    for (const node of nodes) if (!next.includes(node)) node.remove();
    const existing = [...container.children].filter((node) => next.includes(node as HTMLElement));
    if (existing.length !== next.length || existing.some((node, index) => node !== next[index])) container.append(...next);
    nodes = next;
  });
  api.onDispose(() => { for (const node of nodes) node.remove(); });
}

export function mountResources<T>(api: FrontendApi, services: FrontendServices, region: Region, install: (entry: Contribution<T>) => () => void) {
  const mounted = new Map<string, { value: T; dispose(): void }>();
  watchRegion<T>(api, services, region, (entries) => {
    const desired = new Map(entries.map(({ key, id, value }) => [key ?? id, value]));
    for (const [id, item] of mounted) {
      if (desired.get(id) === item.value) continue;
      mounted.delete(id);
      item.dispose();
    }
    for (const entry of entries) {
      const id = entry.key ?? entry.id;
      if (!mounted.has(id)) mounted.set(id, { value: entry.value, dispose: install(entry) });
    }
  });
  api.onDispose(() => { for (const item of mounted.values()) item.dispose(); mounted.clear(); });
}
