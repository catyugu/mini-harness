import type { Context } from 'mini-harness/cordis';
import {
  validateRequestSnapshot,
  type LlmAdapter,
  type LlmRequest,
  type NativeUsage,
} from '@mini-harness/llm/api';
import { DomainError } from '@mini-harness/platform/errors';
import type { RequestRecovery } from '@mini-harness/agent/events';
import type { ContextReplacement, SessionLogReader, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextOccupancy, ContextSettings } from '../shared/state.ts';
import { applyReplacements } from '@mini-harness/sessions/projection';
import { checkpoint, splitPoint } from './compaction.ts';
import { validateSettings } from './config.ts';
import { TokenMeter } from './meter.ts';
import { prune } from './prune.ts';

export const owner = 'context-management';

type Rebuild = (messages: LlmRequest['messages']) => Promise<LlmRequest>;

export class ContextManagement {
  private readonly signatures = new WeakMap<SessionLogPort, Map<string, string | null>>();
  private readonly meter = new TokenMeter();
  private readonly prepared = new WeakMap<
    Pick<SessionLogReader, 'entries'>,
    { occupancy: ContextOccupancy; adapter: LlmAdapter; leafId: string | null; requestId?: string }
  >();
  private readonly operations = new Map<string, 'automatic' | 'recovery'>();

  constructor(
    private readonly settings: () => ContextSettings,
    private readonly notify: (sessionId: string) => void,
  ) {}

  configuration(stored: unknown) {
    const custom = stored == null ? null : validateSettings(stored);
    return { settings: custom ?? this.settings(), custom };
  }

  status(id: string) {
    return { compacting: this.operations.get(id) };
  }

  measure(ctx: Context, request: LlmRequest, count = true) {
    return this.meter.measure(
      request,
      ctx.harnessModels.capabilities(request.model),
      ctx.harnessLlm.select(request.model),
      count,
    );
  }

  occupancy(ctx: Context, log: SessionLogReader, request: LlmRequest, leafId: string | null) {
    const measured = this.prepared.get(log);
    if (
      measured?.leafId === leafId &&
      measured.occupancy.model.provider === request.model.provider &&
      measured.occupancy.model.id === request.model.id
    )
      return measured.occupancy;
    return this.measure(ctx, request, false);
  }

  observe(log: SessionLogPort, requestId: string, usage: NativeUsage) {
    const measured = this.prepared.get(log);
    if (
      !measured ||
      measured.leafId !== log.context().leafId ||
      (measured.requestId && measured.requestId !== requestId)
    )
      return;
    measured.requestId = requestId;
    this.meter.calibrate(measured.occupancy, measured.occupancy, measured.adapter, usage);
  }

  prepare(
    ctx: Context,
    log: SessionLogPort,
    request: LlmRequest,
    rebuild: Rebuild,
    runId?: string,
    repair?: RequestRecovery,
  ) {
    return this.process(ctx, log, request, rebuild, repair ? 'recovery' : 'automatic', runId, repair);
  }

  async compact(ctx: Context, log: SessionLogPort, request: LlmRequest, rebuild: Rebuild) {
    await this.process(ctx, log, request, rebuild, 'manual');
  }

  private async process(
    ctx: Context,
    log: SessionLogPort,
    request: LlmRequest,
    rebuild: Rebuild,
    mode: 'automatic' | 'manual' | 'recovery',
    runId?: string,
    repair?: RequestRecovery,
  ) {
    const { signal } = request;
    const { settings: config } = this.configuration(log.setting(owner));
    const id = log.sessionId;
    const manual = mode === 'manual';
    const fail = (reason: string): never => {
      throw new DomainError(
        manual ? 'invalid_input' : 'unavailable',
        repair ? repair.message + '. Context recovery: ' + reason : reason,
      );
    };
    signal.throwIfAborted();
    if (repair && repair.attempt > 3) fail('The model still rejects the input after three repairs');
    let projection = log.context();
    let occupancy = await this.measure(ctx, request);
    const finish = () => {
      const adapter = ctx.harnessLlm.select(request.model);
      if (adapter) this.prepared.set(log, { occupancy, adapter, leafId: log.context().leafId });
      return request;
    };
    const budget = occupancy.budget;
    if (budget === 0) fail('The model window has no room after reserving its output budget');

    const pressure = budget !== undefined && occupancy.total >= budget * config.triggerRatio;
    let signatures = this.signatures.get(log);
    if (!signatures) this.signatures.set(log, (signatures = new Map()));
    const pruned = prune(ctx, log, projection, signatures, {
      offload: pressure || manual || repair !== undefined,
      forceImages: repair?.kind === 'image-limit',
      toolTokens: Math.max(256, Math.min(4096, Math.floor((budget ?? occupancy.total) * config.retainRatio))),
    });
    if (pruned) {
      projection = log.context();
      request = await rebuild(projection.contextMessages);
      occupancy = await this.measure(ctx, request);
    }
    if (repair?.kind === 'image-limit') {
      if (!pruned) fail('No further images can be offloaded');
      return finish();
    }

    const target = Math.floor(
      (repair || manual
        ? Math.min(budget ?? occupancy.total, occupancy.total)
        : (budget ?? occupancy.total)) * config.targetRatio,
    );
    const needsSummary =
      manual ||
      (config.autoCompact &&
        (repair || (budget !== undefined && occupancy.total >= budget * config.triggerRatio)));
    if (!needsSummary) {
      if (repair && !pruned)
        fail('Automatic compaction is off and pruning cannot reduce this request further');
      return finish();
    }

    let reduced = false;
    if (mode !== 'manual') this.operations.set(id, mode);
    this.notify(id);
    try {
      do {
        const minimum = Math.floor((budget ?? occupancy.messages) * config.retainRatio);
        const retain = Math.max(1, Math.min(minimum, Math.floor(occupancy.messages * config.retainRatio)));
        const { contextMessages, contextEntryIds } = projection;
        const latestUser = contextMessages.reduce(
          (latest, message, index) =>
            message.role === 'user' && log.entry(contextEntryIds[index])?.type === 'message' ? index : latest,
          -1,
        );
        const force = repair || (budget !== undefined && occupancy.total > budget);
        let cut = splitPoint(
          projection,
          this.meter,
          retain,
          force ? Math.max(0, target - occupancy.system - occupancy.tools) : undefined,
        );
        if (cut === latestUser + 1) cut = latestUser;
        const selected = contextMessages.slice(0, cut).filter((_, index) => index !== latestUser);
        const source = log.entry(contextEntryIds[0]);
        if (!selected.length || (selected.length === 1 && source?.type === 'context-replace' && cut === 1)) {
          if (reduced || (pruned && (manual || repair))) break;
          fail('Nothing to compact within the recent-context budget');
        }
        const retained =
          contextMessages.slice(cut).reduce((sum, message) => sum + this.meter.message(message), 0) +
          (latestUser >= 0 && latestUser < cut ? this.meter.message(contextMessages[latestUser]) : 0);
        const summaryBudget = Math.floor(
          Math.min(occupancy.messages, target - occupancy.system - occupancy.tools - retained),
        );
        if (summaryBudget <= 0) {
          if (reduced || (pruned && manual)) break;
          fail('There is no output budget for a continuation checkpoint');
        }
        const summary = await checkpoint(
          ctx,
          log,
          request,
          contextMessages.slice(0, cut),
          config,
          summaryBudget,
          (draft) => this.measure(ctx, draft),
          runId,
        );
        // Preserve the latest submitted message and its source identity even in a long single turn.
        const replacements: ContextReplacement[] =
          latestUser >= 0 && latestUser < cut
            ? [
                { start: latestUser + 1, deleteCount: cut - latestUser - 1, insert: [summary] },
                ...(latestUser ? [{ start: 0, deleteCount: latestUser, insert: [] }] : []),
              ]
            : [{ start: 0, deleteCount: cut, insert: [summary] }];
        const candidate = structuredClone(projection);
        applyReplacements(candidate, replacements, '');
        const next = await rebuild(candidate.contextMessages);
        validateRequestSnapshot(next);
        const measured = await this.measure(ctx, next);
        signal.throwIfAborted();
        if (measured.total >= occupancy.total || measured.messages >= occupancy.messages) {
          if (reduced) break;
          fail('The checkpoint did not reduce the prepared request');
        }
        log.append(
          {
            type: 'context-replace',
            replacements,
          },
          projection.leafId,
        );
        projection = log.context();
        request = next;
        occupancy = measured;
        reduced = true;
      } while (occupancy.total > target);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof DomainError)) throw error;
      if (manual || repair || (budget !== undefined && occupancy.total > budget)) fail(error.message);
      ctx.logger.warn(error.message);
    } finally {
      this.operations.delete(id);
      this.notify(id);
    }
    if (repair && !pruned && !reduced) fail('No further reduction is possible');
    if (budget !== undefined && occupancy.total > budget && !manual)
      fail('The prepared request exceeds the available input budget after compaction');
    return finish();
  }
}
