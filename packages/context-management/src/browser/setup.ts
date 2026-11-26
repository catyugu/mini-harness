import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/conversation/browser/composer-api';
import type {} from '@mini-harness/conversation/browser/conversation-api';
import type {} from '@mini-harness/conversation/browser/history-api';
import type {} from '@mini-harness/ui-slots/browser/api';
import type {} from '@mini-harness/ui-runtime/projection-api';
import { bindPopover } from '@mini-harness/ui-primitives/primitives';
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
  const { occupancy: value, settings } = state;
  const estimate = value?.estimated ? '~' : '';
  const show = (count: number) => estimate + tokens(count);
  rows(list, [
    ['Current context', value ? show(value.total) : 'Unavailable'],
    ['Model window', value?.window ? tokens(value.window) : undefined],
    ['System prompt', value ? show(value.system) : undefined],
    ['Tool schemas', value ? show(value.tools) : undefined],
    ['Messages', value ? show(value.messages) : undefined],
    ['Input budget', value?.budget !== undefined ? tokens(value.budget) : undefined],
    ['Input budget used', value?.budget ? estimate + percent(value.total / value.budget) : undefined],
    ['Auto compaction trigger', percent(settings.triggerRatio) + ' of input budget'],
    ['Auto compaction', settings.autoCompact ? 'On' : 'Off'],
    ['Compaction', state.compacting ? 'Running (' + state.compacting + ')' : undefined],
    ['Last compaction', state.issue],
  ]);
  bar.hidden = !value?.window;
  bar.replaceChildren(
    ...(value?.window
      ? [value.system, value.tools, value.messages].map((size, index) => {
          const segment = document.createElement('span');
          segment.className = 'context-segment-' + index;
          segment.style.flexBasis = percent(Math.min(size / value.window!, 1));
          return segment;
        })
      : []),
  );
}

function mountStats(ctx: Context) {
  const { miniConversation: conversation } = ctx;
  const signal = ctx.fiber.signal;
  const updates = new EventTarget();
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
  conversation.subscribe(['run', 'interaction'], publish, signal);
  ctx.effect(() =>
    ctx.miniProjections.register('context-management', {
      async sync(_revision, _reset, changed) {
        if (!changed || changed === id) await refresh();
      },
    }),
  );
  select();

  const write = async (values: Partial<ContextSettings>) => {
    if (!id) return;
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
      const form = settingsForm(
        ctx,
        signal,
        async (field, value) => {
          if (!state) return;
          const values = { ...state.overrides } as Record<string, unknown>;
          if (value === undefined) delete values[field];
          else values[field] = value;
          await write(values);
        },
        true,
      );
      const compact = button('Compact now'),
        reset = button('Reset to defaults');
      compact.className = 'small-button';
      reset.className = 'link-button';
      const controls = document.createElement('div');
      controls.className = 'context-buttons';
      controls.append(compact, reset);
      compact.onclick = () => void conversation.compact().catch(conversation.report);
      reset.onclick = () => void write({}).catch(conversation.report);
      run.panel.append(runList);
      usage.panel.append(usageList);
      context.panel.append(bar, contextList, form.node, controls);
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
        const ratio = occupancy?.window ? occupancy.total / occupancy.window : undefined;
        ring.style.setProperty('--context-fill', ratio === undefined ? '0%' : percent(Math.min(1, ratio)));
        windowRatio.textContent =
          ratio === undefined ? '—' : (occupancy?.estimated ? '~' : '') + percent(ratio);
        showOccupancy(contextList, bar, state);
        form.update(state.settings, state.overrides);
        const current = conversation.get();
        compact.disabled = Boolean(
          state.compacting ||
            current.interaction.operation ||
            current.run?.state === 'running' ||
            current.run?.state === 'queued' ||
            current.run?.state === 'waiting',
        );
        compact.textContent = state.compacting ? 'Compacting…' : 'Compact now';
        reset.disabled = !Object.keys(state.overrides).length;
      }
      updates.addEventListener('change', render, { signal });
      render();
      return row;
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
        run: conversation.compact,
      }),
    );
  });
}

function setup(ctx: Context) {
  ctx.inject(['miniConversation', 'miniModels', 'miniSlots', 'miniProjections'], mountStats);
  ctx.inject(['miniSettingsRegistry', 'miniModels'], (settings) => {
    const configuration = browserPluginSettings(ctx);
    settings.effect(() =>
      settings.miniSettingsRegistry.register(
        browserPluginId(ctx),
        {
          id: 'context-management',
          section: { title: 'General', icon: 'settings', order: 20 },
          order: 10,
          render({ signal }) {
            const form = settingsForm(settings, signal, (field, value) => configuration.set(field, value));
            const read = () =>
              form.update({
                autoCompact: configuration.get('autoCompact'),
                triggerRatio: configuration.get('triggerRatio'),
                targetRatio: configuration.get('targetRatio'),
                retainRatio: configuration.get('retainRatio'),
                pruneTools: configuration.get('pruneTools'),
                summaryModel: configuration.get('summaryModel'),
              });
            for (const key of [
              'autoCompact',
              'triggerRatio',
              'targetRatio',
              'retainRatio',
              'pruneTools',
              'summaryModel',
            ])
              signal.addEventListener('abort', configuration.subscribe(key, read), { once: true });
            read();
            return form.node;
          },
        },
        configuration,
      ),
    );
  });
}

export default { inject: [], apply: setup };
