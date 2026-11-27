import type { ToolPlacement, ToolRenderer, ToolRenderInstance, ToolView } from '../history-api.ts';
import type { MessageExtensions } from './message-extensions.ts';
import { icon } from '@mini-harness/ui-primitives/icons';
import { rasterImage, textOutput } from '@mini-harness/ui-primitives/primitives';
import { textOf } from './timeline.ts';

export type ToolCardData = ToolView & { elapsedMs?: number };

const labels: Record<string, string> = {
  finished: 'Done',
  running: 'Running',
  approval: 'Waiting for approval',
  denied: 'Denied',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  error: 'Failed',
};

export function createToolCard(initial: ToolCardData, extensions: MessageExtensions, signal: AbortSignal) {
  let current = initial;
  const node = document.createElement('details');
  node.className = 'tool-card ui-record ui-disclosure';
  const header = document.createElement('summary');
  const name = document.createElement('strong');
  name.className = 'ui-record-label ui-truncate';
  name.textContent = initial.name.replaceAll('_', ' ');
  name.title = initial.name;
  const summary = document.createElement('span');
  summary.className = 'tool-summary-slot ui-row ui-fill';
  const duration = document.createElement('span');
  duration.className = 'tool-duration ui-fixed';
  const status = document.createElement('span');
  status.className = 'tool-state ui-fixed';
  const statusLabel = document.createElement('span');
  status.append(statusLabel);
  header.append(icon('chevron'), name, summary, duration, status);
  const body = document.createElement('div');
  body.className = 'tool-content';
  const detail = document.createElement('div');
  const actions = document.createElement('div');
  body.append(detail, actions);
  node.append(header, body);

  const fallback = document.createElement('div');
  const output = textOutput('');
  const outputText = document.createTextNode('');
  output.append(outputText);
  const images = document.createElement('div');
  fallback.append(output, images);
  let previousContent: ToolView['content'];
  function updateFallback(tool: ToolView) {
    const text = textOf(tool.content) || Object.values(tool.streams ?? {}).join('');
    if (outputText.data !== text) {
      if (text.startsWith(outputText.data)) outputText.appendData(text.slice(outputText.length));
      else outputText.data = text;
    }
    output.hidden = !text;
    if (previousContent !== tool.content) {
      previousContent = tool.content;
      const blocks = typeof tool.content === 'string' ? [] : (tool.content ?? []);
      const rendered = blocks.flatMap((block) => {
        if (block.type !== 'image') return [];
        const image = rasterImage(block.mimeType, block.data, 'Tool output');
        return image ? [image] : [];
      });
      images.replaceChildren(...rendered);
      images.hidden = !rendered.length;
    }
    fallback.hidden = output.hidden && !images.childElementCount;
  }

  function placement(kind: ToolPlacement, host: HTMLElement) {
    let renderer: ToolRenderer | undefined;
    let instance: ToolRenderInstance | undefined;
    let lifetime: AbortController | undefined;
    function release() {
      lifetime?.abort();
      lifetime = undefined;
      instance?.node.remove();
      instance = undefined;
    }
    signal.addEventListener('abort', release, { once: true });
    function update(tool: ToolView) {
      const selected = extensions.toolRenderer(tool.name, kind);
      if (selected !== renderer) {
        release();
        renderer = selected;
        if (renderer) {
          lifetime = new AbortController();
          try {
            instance = renderer(lifetime.signal);
            host.append(instance.node);
          } catch (error) {
            release();
            extensions.report(error);
          }
        }
      }
      if (instance) {
        try {
          instance.update(tool);
        } catch (error) {
          release();
          extensions.report(error);
        }
      }
      return instance?.node;
    }
    return update;
  }

  const updateSummary = placement('summary', summary);
  const updateStatus = placement('status', status);
  const updateBody = placement('body', detail);
  const updateAction = placement('action', actions);

  function refresh(kind: ToolPlacement) {
    switch (kind) {
      case 'summary': {
        const contribution = updateSummary(current);
        summary.hidden = !contribution || contribution.hidden;
        break;
      }
      case 'status': {
        const contribution = updateStatus(current);
        const label = contribution && !contribution.hidden ? '' : (labels[current.state] ?? current.state);
        if (statusLabel.textContent !== label) statusLabel.textContent = label;
        statusLabel.hidden = !label;
        break;
      }
      case 'body':
        if (updateBody(current)) fallback.remove();
        else {
          updateFallback(current);
          if (!fallback.parentElement) detail.append(fallback);
        }
        break;
      case 'action': {
        const contribution = updateAction(current);
        actions.hidden = !contribution || contribution.hidden;
        break;
      }
    }
  }

  function update(tool: ToolCardData) {
    current = tool;
    if (node.dataset.state !== tool.state) node.dataset.state = tool.state;
    const elapsed = tool.elapsedMs;
    const label =
      elapsed === undefined || !Number.isFinite(elapsed)
        ? ''
        : elapsed < 1000
          ? Math.round(elapsed) + ' ms'
          : (elapsed / 1000).toFixed(1) + ' s';
    if (duration.textContent !== label) duration.textContent = label;
    duration.hidden = !label;
    refresh('summary');
    refresh('status');
    refresh('body');
    refresh('action');
  }
  update(initial);
  return { node, name: initial.name, update, refresh };
}
