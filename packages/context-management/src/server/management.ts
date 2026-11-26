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
import type { ContextReplacement, SessionContext, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextSettings } from '../shared/state.ts';
import { checkpoint, splitPoint } from './compaction.ts';
import { validateSettings } from './config.ts';
import { calibration, estimate, measure, messageTokens, totalTokens, type MeasuredRequest } from './meter.ts';
import { offloadImages, offloadMessage, prune } from './prune.ts';

export const owner = 'context-management';

export function configuration(stored: unknown, defaults: ContextSettings) {
  return { settings: stored == null ? defaults : validateSettings(stored), customized: stored != null };
}

type Rebuild = (messages: NativeMessage[]) => Promise<LlmRequest>;

function pendingInputStart(log: SessionLogPort, projection: SessionContext) {
  const pending = new Set<string>();
  for (const entry of log.branch().reverse()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (
      message.role === 'assistant' &&
      !message.errorMessage &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted'
    )
      break;
    if (message.role === 'user') pending.add(entry.id);
  }
  const first = projection.contextEntryIds.findIndex((id) => pending.has(id));
  return first === -1 ? projection.contextMessages.length : first;
}

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

  private measure(log: SessionLogPort, request: LlmRequest) {
    const { capability, adapter } = this.model(request.model);
    return measure(
      request,
      capability,
      adapter,
      adapter.countInputTokens ? 1 : calibration(log, request.model),
    );
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
    return this.measure(log, await this.replace(log, request, rebuild, prune(log.context())));
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
    const rawMessages = estimate(request).messages;
    const messageScale = rawMessages && counts.messages ? counts.messages / rawMessages : 1;
    const retain = Math.ceil(
      (Math.min(counts.budget, counts.messages) * settings.retainRatio) / messageScale,
    );
    const cut = Math.min(splitPoint(messages, retain), pendingInputStart(log, projection));
    if (!cut) return;
    const kept = messages.slice(cut);
    const retained = Math.ceil(kept.reduce((sum, message) => sum + messageTokens(message), 0) * messageScale);
    // The target is aspirational; the retained suffix must leave room for a smaller
    // checkpoint within the actual model input budget.
    const available = Math.min(counts.budget, totalTokens(counts) - 1) - fixed - retained;
    if (available <= 0) return;
    const desired = target - fixed - retained;
    const checkpointTarget = desired > 0 ? Math.min(desired, available) : available;
    const { model } = selectModel(this.models, { explicit: settings.summaryModel ?? request.model });
    const { capability, adapter } = this.model(model);
    const scale = adapter.countInputTokens ? 1 : calibration(log, model);
    const currentModel = this.model(request.model);
    const currentScale = currentModel.adapter.countInputTokens ? 1 : calibration(log, request.model);
    const summaryRequest: LlmRequest = {
      model,
      systemPrompt:
        'Prepare a continuation checkpoint. Aim for at most ' +
        checkpointTarget +
        ' tokens of checkpoint text.',
      messages: [],
      thinkingLevel: 'off',
      maxTokens: capability.maxTokens,
      signal: request.signal,
    };
    const summary = await checkpoint(
      summaryRequest,
      capability,
      adapter,
      messages.slice(0, cut).map((message, index) => offloadMessage(message, contextEntryIds[index])),
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
      scale,
    );
    const next = await measure(
      await rebuild([summary, ...kept]),
      currentModel.capability,
      currentModel.adapter,
      currentScale,
    );
    validateRequestSnapshot(next);
    request.signal.throwIfAborted();
    if (totalTokens(next.inputMeasurement) >= totalTokens(counts)) return;
    if (totalTokens(next.inputMeasurement) > next.inputMeasurement.budget)
      throw new DomainError(
        'unavailable',
        'Checkpoint must reduce the request and fit the model input budget',
      );
    log.append(
      {
        type: 'context-replace',
        replacements: [{ start: 0, deleteCount: cut, insert: [summary] }],
        measurement: { ...next.inputMeasurement, model: next.model },
        display: {
          owner: { pluginId: owner, instanceId: owner },
          kind: 'checkpoint',
          title: 'Context compacted',
          source: ['replacements', 0, 'insert', 0, 'content'],
        },
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
    const replacements = prune(log.context());
    let changed = replacements.length > 0;
    let current = await this.measure(log, await this.replace(log, request, rebuild, replacements));
    const pressure = () =>
      totalTokens(current.inputMeasurement) >= current.inputMeasurement.budget * settings.triggerRatio;
    if (pressure() || failure) {
      const projection = log.context();
      const images = offloadImages(projection, pendingInputStart(log, projection));
      if (images.length) {
        changed = true;
        current = await this.measure(log, await this.replace(log, current, rebuild, images));
      }
      if (failure?.kind === 'image-limit' && !images.length)
        throw new DomainError(
          'unavailable',
          'No historical images can be offloaded without changing pending user input',
        );
    }
    const overflow = failure?.kind === 'context-overflow';
    if (settings.autoCompact && (overflow || pressure())) {
      const next = await this.compact(log, current, rebuild, settings, taskId);
      if (next) return next;
    }
    if (totalTokens(current.inputMeasurement) > current.inputMeasurement.budget)
      throw new DomainError('unavailable', 'The prepared request exceeds its input budget');
    if (
      overflow &&
      (!changed ||
        totalTokens(current.inputMeasurement) >=
          totalTokens((await this.measure(log, request)).inputMeasurement))
    )
      throw new DomainError(
        'unavailable',
        settings.autoCompact
          ? 'No further context reduction is possible'
          : 'Automatic compaction is off and no further deterministic reduction is possible',
      );
    return current;
  }
}
