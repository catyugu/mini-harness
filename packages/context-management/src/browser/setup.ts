import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/conversation/browser/composer-api';
import type {} from '@mini-harness/conversation/browser/conversation-api';
import type {} from '@mini-harness/conversation/browser/history-api';
import type {} from '@mini-harness/conversation/browser/navigation-api';
import type {} from '@mini-harness/settings/browser/api';
import type {} from '@mini-harness/ui-slots/browser/api';
import type {} from '@mini-harness/ui-runtime/projection-api';
import { bindPopover, button as uiButton, iconButton } from '@mini-harness/ui-primitives/primitives';
import { browserRequest, payload } from '@mini-harness/ui-runtime/http';
import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { ContextSettings, ContextState, TokenTotals } from '../shared/state.ts';
import { settingsForm } from './form.ts';

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const short = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const percent = (value: number) => number.format(value * 100) + '%';
const tokens = (count: number) => number.format(count) + ' tok';
const seconds = (ms: number) => number.format(ms / 1000) + ' s';
const totalInput = ({ input, cacheRead, cacheWrite = 0 }: TokenTotals) => input + cacheRead + cacheWrite;
const cache = (usage: TokenTotals) =>
  totalInput(usage) ? percent(usage.cacheRead / totalInput(usage)) : '—';

function button(label: string) {
  const result = document.createElement('button');
  result.type = 'button';
  result.textContent = label;
  return result;
}

function detail(label: string, signal: AbortSignal) {
  const node = document.createElement('div');
  const trigger = button(label);
  trigger.className = 'context-statistic link-button';
  trigger.setAttribute('aria-label', label);
  trigger.title = label;
  trigger.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  panel.className = 'ui-popover context-details';
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  node.append(trigger, panel);
  const position = bindPopover(trigger, panel, signal, { width: 340, prefer: 'above', maxHeight: 510 });
  trigger.onclick = () => {
    if (panel.matches(':popover-open')) panel.hidePopover();
    else {
      panel.showPopover();
      position();
    }
  };
  return { node, trigger, panel };
}

function rows(list: HTMLElement, values: [string, string | undefined][]) {
  list.replaceChildren(
    ...values.flatMap(([label, value]) => {
      if (value === undefined) return [];
      const key = document.createElement('dt');
      key.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      return [key, description];
    }),
  );
}

function showUsage(list: HTMLElement, usage?: TokenTotals) {
  rows(
    list,
    usage
      ? [
          ['Total usage', tokens(totalInput(usage) + usage.output)],
          ['Uncached input', tokens(usage.input)],
          ['Cache read', tokens(usage.cacheRead)],
          ['Cache write', usage.cacheWrite === undefined ? undefined : tokens(usage.cacheWrite)],
          ['Output', tokens(usage.output)],
          ['Input cache hit rate', cache(usage)],
        ]
      : [['Usage', 'Unavailable']],
  );
}

function showOccupancy(list: HTMLElement, bar: HTMLElement, state: ContextState) {
  const { occupancy: value } = state;
  const estimate = value?.estimated ? '~' : '';
  const show = (count: number) => estimate + tokens(count);
  rows(list, [
    ['Last measured input', value ? show(value.total) : 'Unavailable'],
    ['Model window', value ? tokens(value.window) : undefined],
    ['System prompt', value ? show(value.system) : undefined],
    ['Tool schemas', value ? show(value.tools) : undefined],
    ['Messages', value ? show(value.messages) : undefined],
    ['Input budget', value ? tokens(value.budget) : undefined],
    ['Input budget used', value ? estimate + percent(value.total / value.budget) : undefined],
  ]);
  bar.hidden = !value;
  bar.replaceChildren(
    ...(value
      ? [value.system, value.tools, value.messages].map((size, index) => {
          const segment = document.createElement('span');
          segment.className = 'context-segment-' + index;
          segment.style.flexBasis = percent(Math.min(size / value.window, 1));
          return segment;
        })
      : []),
  );
}

function profileSettings(ctx: Context) {
  const configuration = browserPluginSettings(ctx);
  const read = (): ContextSettings => ({
    autoCompact: configuration.get('autoCompact'),
    triggerRatio: configuration.get('triggerRatio'),
    targetRatio: configuration.get('targetRatio'),
    retainRatio: configuration.get('retainRatio'),
    summaryModel: configuration.get('summaryModel'),
  });
  return { configuration, read };
}

function mountStats(ctx: Context) {
  const { miniConversation: conversation } = ctx;
  const signal = ctx.fiber.signal;
  const updates = new EventTarget();
  const drafts = new Map<string, ContextSettings>();
  const { read: defaults } = profileSettings(ctx);
  const workspace = () => ctx.harnessBrowser.workspace()?.workspaceId;
  let draftWorkspace = workspace();
  let state: ContextState | undefined;
  let id: string | undefined;
  let controller = new AbortController();
  let inFlight: Promise<void> | undefined;
  let queued = false;
  const path = (id: string) => '/sessions/' + encodeURIComponent(id) + '/context';
  const publish = () => updates.dispatchEvent(new Event('change'));

  function refresh() {
    queued = true;
    return (inFlight ??= (async () => {
      while (queued && !signal.aborted) {
        queued = false;
        if (!id) break;
        const request = controller;
        const data = await browserRequest<ContextState>(ctx, path(id), { signal: request.signal }).catch(
          (error) => {
            if (!request.signal.aborted && !signal.aborted)
              console.error('Could not load context statistics', error);
          },
        );
        if (data && !request.signal.aborted) {
          state = data;
          publish();
        }
      }
    })().finally(() => {
      inFlight = undefined;
    }));
  }

  function select() {
    const next = conversation.get().session?.id;
    if (id === next) return;
    controller.abort();
    controller = new AbortController();
    id = next;
    state = undefined;
    publish();
    void refresh();
  }
  conversation.subscribe(['session'], select, signal);
  conversation.subscribe(['interaction'], publish, signal);
  ctx.harnessBrowser.onConversationChange(() => {
    const next = workspace();
    if (next !== draftWorkspace) {
      draftWorkspace = next;
      publish();
    }
  }, signal);
  ctx.on('conversation/initialize', async (workspaceId, sessionId) => {
    const settings = drafts.get(workspaceId);
    if (!settings) return;
    await browserRequest(ctx, path(sessionId), payload('PUT', settings));
    drafts.delete(workspaceId);
    if (id === sessionId) await refresh();
  });
  ctx.effect(() =>
    ctx.miniProjections.register('context-management', {
      async sync(_revision, _reset, changed) {
        if (!changed || changed === id) await refresh();
      },
    }),
  );
  select();

  const write = async (values: ContextSettings | null) => {
    if (!id) {
      const key = workspace();
      if (!key) throw new Error('Choose a workspace first.');
      if (values) drafts.set(key, values);
      else drafts.delete(key);
      publish();
      return;
    }
    const request = controller;
    await browserRequest(ctx, path(id), { ...payload('PUT', values), signal: request.signal });
    if (!request.signal.aborted) await refresh();
  };

  ctx.effect(() =>
    ctx.miniSlots.register('conversation.composer-footer', (signal) => {
      const row = document.createElement('div');
      row.className = 'context-status';
      row.setAttribute('aria-label', 'Conversation statistics');
      const run = detail('Run statistics', signal);
      const usage = detail('Token usage', signal);
      const context = detail('Context usage', signal);
      context.trigger.title = 'Last measured input / model window';
      const speed = document.createElement('span');
      speed.className = 'context-speed';
      const runList = document.createElement('dl'),
        usageList = document.createElement('dl'),
        contextList = document.createElement('dl');
      const bar = document.createElement('div');
      bar.className = 'context-bar';
      bar.setAttribute('aria-hidden', 'true');
      const ring = document.createElement('span');
      ring.className = 'context-ring';
      ring.setAttribute('aria-hidden', 'true');
      const windowRatio = document.createElement('span');
      context.trigger.replaceChildren(ring, windowRatio);
      run.panel.append(runList);
      usage.panel.append(usageList);
      context.panel.append(bar, contextList);
      row.append(run.node, usage.node, context.node);

      function render() {
        row.hidden = !state;
        if (!state) {
          for (const item of [run, usage, context])
            if (item.panel.matches(':popover-open')) item.panel.hidePopover();
          return;
        }
        const { turns, steps, tokensPerSecond, modelMs, toolMs, ttftMs, occupancy, usage: totals } = state;
        speed.textContent = tokensPerSecond ? ' · ' + number.format(tokensPerSecond) + ' tok/s' : '';
        run.trigger.replaceChildren(
          turns + (turns === 1 ? ' turn' : ' turns') + ' · ' + steps + (steps === 1 ? ' step' : ' steps'),
          speed,
        );
        rows(runList, [
          ['Turns', String(turns)],
          ['Steps', String(steps)],
          ['Model time', modelMs === undefined ? undefined : seconds(modelMs)],
          ['Tool time', toolMs === undefined ? undefined : seconds(toolMs)],
          ['Average time to first token', ttftMs === undefined ? undefined : seconds(ttftMs)],
          [
            'Output speed',
            tokensPerSecond === undefined ? undefined : number.format(tokensPerSecond) + ' tok/s',
          ],
        ]);
        usage.trigger.textContent = totals
          ? short.format(totalInput(totals) + totals.output) + ' tok · Cache ' + cache(totals)
          : '— tok';
        showUsage(usageList, totals);
        const ratio = occupancy ? occupancy.total / occupancy.window : undefined;
        ring.style.setProperty('--context-fill', ratio === undefined ? '0%' : percent(Math.min(1, ratio)));
        windowRatio.textContent =
          ratio === undefined ? '—' : 'Last ' + (occupancy?.estimated ? '~' : '') + percent(ratio);
        showOccupancy(contextList, bar, state);
      }
      updates.addEventListener('change', render, { signal });
      render();
      return row;
    }),
  );

  const compactConversation = async () => {
    if (!id) throw new Error('Open a conversation to compact it.');
    const sessionId = id;
    const result = await browserRequest<{ cancelled?: boolean; compacted?: boolean }>(
      ctx,
      '/sessions/' + encodeURIComponent(sessionId) + '/compact',
      payload('POST', {}),
    );
    if (id === sessionId && (await conversation.activate(sessionId, false)))
      conversation.report(
        result.cancelled
          ? 'Compaction cancelled.'
          : result.compacted
            ? 'Conversation compacted.'
            : 'Nothing to compact.',
      );
  };

  ctx.effect(() =>
    ctx.miniSlots.register('conversation.composer-options', (signal) => {
      const node = document.createElement('div');
      const trigger = iconButton('Context settings', 'settings');
      const panel = document.createElement('div');
      panel.className = 'ui-popover context-details';
      panel.setAttribute('popover', 'auto');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Context settings');
      node.append(trigger, panel);
      const position = bindPopover(trigger, panel, signal, { width: 300, prefer: 'above' });
      const draft = () => {
        const key = workspace();
        return key ? drafts.get(key) : undefined;
      };
      const currentSettings = () => state?.settings ?? draft() ?? defaults();
      trigger.onclick = () => {
        if (panel.matches(':popover-open')) panel.hidePopover();
        else {
          form.update(currentSettings());
          panel.showPopover();
          position();
        }
      };
      const form = settingsForm(ctx, signal, write);
      const reset = uiButton('Restore defaults', 'quiet');
      reset.onclick = () =>
        void write(null)
          .then(() => {
            form.update(currentSettings());
          })
          .catch(conversation.report);
      panel.append(form.node, reset);
      let shownId = id;
      let shownWorkspace = workspace();
      const render = () => {
        const key = workspace();
        trigger.disabled = Boolean(id && !state) || Boolean(conversation.get().interaction.operation);
        if (shownId !== id || shownWorkspace !== key) {
          shownId = id;
          shownWorkspace = key;
          if (panel.matches(':popover-open')) panel.hidePopover();
        }
        reset.disabled = !(id ? state?.customized : draft());
      };
      updates.addEventListener('change', render, { signal });
      render();
      return node;
    }),
  );

  ctx.inject(['miniMessages'], (history) => {
    history.effect(() =>
      history.miniMessages.registerTurnFooter('token-usage', ({ sessionId, messageId, signal }) => {
        const usage = detail('Turn token usage', signal);
        usage.node.className = 'turn-usage';
        const list = document.createElement('dl');
        usage.panel.append(list);
        const render = () => {
          const total = sessionId === id ? state?.assistantUsage[messageId] : undefined;
          usage.node.hidden = !total;
          if (!total) return;
          usage.trigger.textContent = short.format(totalInput(total) + total.output) + ' tok';
          showUsage(list, total);
        };
        updates.addEventListener('change', render, { signal });
        render();
        return usage.node;
      }),
    );
  });
  ctx.inject(['miniComposer'], (composer) => {
    composer.effect(() =>
      composer.miniComposer.command({
        name: 'compact',
        group: 'Conversation',
        description: 'Summarize earlier messages to free context',
        run: compactConversation,
      }),
    );
  });
}

function setup(ctx: Context) {
  ctx.inject(['miniConversation', 'miniModels', 'miniSlots', 'miniProjections', 'harnessBrowser'], mountStats);
  ctx.inject(['miniSettingsRegistry', 'miniModels'], (settings) => {
    const { configuration, read } = profileSettings(ctx);
    settings.effect(() =>
      settings.miniSettingsRegistry.register(
        browserPluginId(ctx),
        {
          id: 'context-management',
          section: { title: 'General', icon: 'settings', order: 20 },
          order: 10,
          render({ signal }) {
            const form = settingsForm(settings, signal, (value) => configuration.patch({ ...value }));
            const update = () => form.update(read());
            for (const key of ['autoCompact', 'triggerRatio', 'targetRatio', 'retainRatio', 'summaryModel'])
              signal.addEventListener('abort', configuration.subscribe(key, update), { once: true });
            update();
            return form.node;
          },
        },
        configuration,
      ),
    );
  });
}

export default { inject: [], apply: setup };
