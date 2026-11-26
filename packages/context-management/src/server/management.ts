import {
  validateRequestSnapshot,
  type LlmPort,
  type LlmRequest,
  type NativeMessage,
} from '@mini-harness/llm/api';
import type { ModelCatalogPort } from '@mini-harness/models/api';
import type { ModelFailure, ModelRetry } from '@mini-harness/agent/events';
import { requestModel } from '@mini-harness/agent/model-request';
import { selectModel } from '@mini-harness/models/selection';
import { DomainError } from '@mini-harness/platform/errors';
import type { ContextReplacement, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextSettings } from '../shared/state.ts';
import { checkpoint, splitPoint } from './compaction.ts';
import { validateSettings } from './config.ts';
import { measure, messageTokens, textTokens, totalTokens, type MeasuredRequest } from './meter.ts';
import { offloadImages, prune } from './prune.ts';

export const owner = 'context-management';

export function configuration(stored: unknown, defaults: ContextSettings) {
  return { settings: stored == null ? defaults : validateSettings(stored), customized: stored != null };
}

type Rebuild = (messages: NativeMessage[]) => Promise<LlmRequest>;

export class ContextManagement {
  constructor(
    private readonly models: ModelCatalogPort,
    private readonly llm: LlmPort,
    private readonly retry: (failure: ModelFailure) => Promise<ModelRetry | undefined>,
  ) {}

  private model(choice: LlmRequest['model']) {
    const capability = this.models.capabilities(choice);
    const adapter = this.llm.select(choice);
    if (!capability || !adapter)
      throw new DomainError('invalid_input', 'Model capability or adapter unavailable: ' + choice.id);
    return { capability, adapter };
  }

  private measure(request: LlmRequest) {
    const { capability, adapter } = this.model(request.model);
    return measure(request, capability, adapter);
  }

  private async replace(
    log: SessionLogPort,
    request: LlmRequest,
    rebuild: Rebuild,
    replacements: ContextReplacement[],
  ) {
    if (!replacements.length) return request;
    log.append({ type: 'context-replace', replacements }, log.context().leafId);
    return rebuild(log.context().contextMessages);
  }

  async prune(log: SessionLogPort, request: LlmRequest, rebuild: Rebuild) {
    return this.measure(await this.replace(log, request, rebuild, prune(log.context())));
  }

  async compact(
    log: SessionLogPort,
    request: MeasuredRequest,
    rebuild: Rebuild,
    settings: ContextSettings,
    taskId: string,
  ) {
    const counts = request.inputMeasurement;
    const projection = log.context();
    const { contextMessages: messages, contextEntryIds } = projection;
    const fixed = counts.system + counts.tools;
    const target = Math.min(
      Math.floor(counts.budget * settings.targetRatio),
      fixed + Math.floor(counts.messages * settings.targetRatio),
    );
    const retain = Math.floor(Math.min(counts.budget, counts.messages) * settings.retainRatio);
    const cut = splitPoint(messages, retain);
    if (!cut) throw new DomainError('invalid_input', 'Nothing to compact within the recent-context budget');
    const kept = messages.slice(cut);
    const retained = kept.reduce((sum, message) => sum + messageTokens(message), 0);
    const latest = log
      .branch()
      .reverse()
      .find((entry) => entry.type === 'message' && entry.message.role === 'user');
    let original = '';
    if (latest?.type === 'message' && !contextEntryIds.slice(cut).includes(latest.id)) {
      const text =
        latest.presentation?.userText ??
        (typeof latest.message.content === 'string'
          ? latest.message.content
          : latest.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'));
      original = '\n\nLatest user request (verbatim):\n' + text + '\n[Original entry: ' + latest.id + ']';
    }
    const output = target - fixed - retained - textTokens(original);
    if (output <= 0) throw new DomainError('unavailable', 'Context budget cannot accommodate a checkpoint');
    const { model } = selectModel(this.models, { explicit: settings.summaryModel ?? request.model });
    const { capability, adapter } = this.model(model);
    const summaryRequest: LlmRequest = {
      model,
      systemPrompt: 'Prepare a continuation checkpoint.',
      messages: [],
      maxTokens: Math.min(capability.maxTokens, output),
      signal: request.signal,
    };
    const summary = await checkpoint(
      summaryRequest,
      capability,
      adapter,
      messages.slice(0, cut),
      async (outgoing) => {
        validateRequestSnapshot(outgoing);
        const { id: requestId } = log.recordRequest(outgoing, 'summary');
        return requestModel(this.llm, outgoing, {
          retry: this.retry,
          attempt(metrics) {
            log.append({ type: 'model-attempt', requestId, runId: taskId, summary: true, ...metrics });
          },
        });
      },
    );
    summary.content += original;
    const next = await this.measure(await rebuild([summary, ...kept]));
    validateRequestSnapshot(next);
    request.signal.throwIfAborted();
    if (
      totalTokens(next.inputMeasurement) >= totalTokens(counts) ||
      totalTokens(next.inputMeasurement) > target
    )
      throw new DomainError('unavailable', 'Checkpoint does not satisfy the target input budget');
    log.append(
      {
        type: 'context-replace',
        replacements: [{ start: 0, deleteCount: cut, insert: [summary] }],
        measurement: { ...next.inputMeasurement, model: next.model },
      },
      projection.leafId,
    );
    return next;
  }

  async prepare(
    log: SessionLogPort,
    request: LlmRequest,
    rebuild: Rebuild,
    settings: ContextSettings,
    taskId: string,
    failure?: ModelFailure,
  ) {
    if (failure && failure.kind !== 'context-overflow' && failure.kind !== 'image-limit') return;
    let current = await this.prune(log, request, rebuild);
    const pressure = () =>
      totalTokens(current.inputMeasurement) >= current.inputMeasurement.budget * settings.triggerRatio;
    if (pressure() || failure) {
      const images = offloadImages(log.context(), failure?.kind === 'image-limit');
      if (images.length) current = await this.measure(await this.replace(log, current, rebuild, images));
      if (failure?.kind === 'image-limit') {
        if (!images.length) throw new DomainError('unavailable', 'No further images can be offloaded');
        return current;
      }
    }
    if (failure && !settings.autoCompact) throw new DomainError('unavailable', 'Automatic compaction is off');
    if (settings.autoCompact && (failure || pressure()))
      return this.compact(log, current, rebuild, settings, taskId);
    if (totalTokens(current.inputMeasurement) > current.inputMeasurement.budget)
      throw new DomainError('unavailable', 'The prepared request exceeds its input budget');
    return current;
  }
}
