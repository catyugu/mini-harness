import type { Context } from 'mini-harness/cordis';
import {
  validateRequestSnapshot,
  type LlmAdapter,
  type LlmRequest,
  type NativeUsage,
} from '@mini-harness/llm/api';
import { DomainError } from '@mini-harness/platform/errors';
import type { ContextRepair, ContextRequest } from '@mini-harness/runs/context-management';
import type { SessionContext, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextOccupancy, ContextSettings, ContextState } from '../shared/state.ts';
import { checkpoint, splitPoint } from './compaction.ts';
import { resolveSettings } from './config.ts';
import { TokenMeter } from './meter.ts';
import { prune } from './prune.ts';

export const owner = 'context-management';

export class ContextManagement {
  private readonly signatures = new WeakMap<SessionLogPort, Map<string, string | null>>();
  private readonly meter = new TokenMeter();
  private readonly prepared = new WeakMap<
    LlmRequest['messages'],
    { occupancy: ContextOccupancy; adapter: LlmAdapter }
  >();
  private readonly operations = new Map<string, NonNullable<ContextState['compacting']>>();

  constructor(
    private readonly settings: () => ContextSettings,
    private readonly notify: (sessionId: string) => void,
  ) {}

  configuration(stored: unknown, strict = true) {
    const overrides = (stored ?? {}) as Partial<ContextSettings>;
    const defaults = this.settings();
    try {
      return { settings: resolveSettings(defaults, overrides), overrides };
    } catch (error) {
      if (strict) throw error;
      return {
        settings: { ...defaults, ...overrides },
        overrides,
        issue: error instanceof Error ? error.message : String(error),
      };
    }
  }

  status(id: string) {
    return { compacting: this.operations.get(id) };
  }

  async measure(ctx: Context, request: LlmRequest, projection?: SessionContext, count = true) {
    const adapter = ctx.get('harnessLlm')?.select?.(request.model);
    const occupancy = await this.meter.measure(
      request,
      ctx.get('harnessModels')?.capabilities(request.model),
      adapter,
      projection,
      count,
    );
    if (count && adapter) this.prepared.set(request.messages, { occupancy, adapter });
    return occupancy;
  }

  observe(request: Omit<LlmRequest, 'signal'>, usage: NativeUsage) {
    const measured = this.prepared.get(request.messages);
    if (measured) this.meter.calibrate(request, measured.occupancy, measured.adapter, usage);
  }

  prepare(input: ContextRequest, repair?: ContextRepair) {
    return this.process(input, repair ? 'recovery' : 'automatic', repair);
  }

  async compact(input: ContextRequest) {
    await this.process(input, 'manual');
  }

  private async process(
    input: ContextRequest,
    mode: 'automatic' | 'manual' | 'recovery',
    repair?: ContextRepair,
  ) {
    const { log, signal } = input;
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
    let request = await input.assemble(projection);
    let occupancy = await this.measure(input.ctx, request, projection);
    const budget = occupancy.budget;
    if (budget === 0) fail('The model window has no room after reserving its output budget');

    const pressure = budget !== undefined && occupancy.total >= budget * config.triggerRatio;
    let signatures = this.signatures.get(log);
    if (!signatures) this.signatures.set(log, (signatures = new Map()));
    const pruned =
      prune(input, projection, signatures, {
        offload: pressure || manual || repair !== undefined,
        forceImages: repair?.kind === 'image-limit',
        toolTokens: Math.max(256, Math.min(4096, Math.floor((budget ?? 64_000) * (repair ? 0.03 : 0.09)))),
      });
    if (pruned) {
      projection = log.context();
      request = await input.assemble(projection);
      occupancy = await this.measure(input.ctx, request, projection);
    }
    if (repair?.kind === 'image-limit') {
      if (!pruned) fail('No further images can be offloaded');
      return request;
    }

    const target = Math.floor(
      (budget ?? occupancy.total) *
        (repair ? Math.min(config.targetRatio, 0.5 / repair.attempt) : config.targetRatio),
    );
    const needsSummary =
      manual ||
      (config.autoCompact &&
        (repair || (budget !== undefined && occupancy.total >= budget * config.triggerRatio)));
    if (!needsSummary) {
      if (repair && !pruned)
        fail('Automatic compaction is off and pruning cannot reduce this request further');
      return request;
    }

    let reduced = false;
    this.operations.set(id, mode);
    this.notify(id);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const minimum = (budget ?? occupancy.messages) * config.retainRatio;
        const retain = Math.max(
          1,
          Math.floor(
            manual && occupancy.messages <= minimum
              ? occupancy.messages * config.retainRatio
              : minimum,
          ),
        );
        const force = repair || (budget !== undefined && occupancy.total > budget);
        const checkpointAtStart = log.branch(projection.leafId).some(
          (entry) =>
            entry.id === projection.contextEntryIds[0] &&
            (entry.type === 'context-replace' || entry.type === 'compaction'),
        );
        const cut = splitPoint(
          projection,
          this.meter,
          retain,
          checkpointAtStart,
          force ? Math.max(0, (budget ?? occupancy.total) - occupancy.system - occupancy.tools) : undefined,
        );
        if (!cut) {
          if (reduced || (pruned && (manual || repair))) break;
          fail('Nothing to compact within the recent-context budget');
        }
        const summaryBudget = Math.min(
          4096,
          Math.max(96, target - occupancy.system - occupancy.tools - retain),
        );
        const summary = await checkpoint(
          input,
          request,
          projection.contextMessages.slice(0, cut),
          config,
          summaryBudget,
          (draft) => this.measure(input.ctx, draft),
        );
        const candidate = {
          ...projection,
          contextMessages: [summary, ...projection.contextMessages.slice(cut)],
          contextRevisions: ['', ...projection.contextRevisions.slice(cut)],
        };
        const next = await input.assemble(candidate);
        validateRequestSnapshot(next);
        const measured = await this.measure(input.ctx, next, candidate);
        signal.throwIfAborted();
        if (measured.total >= occupancy.total || measured.messages >= occupancy.messages) {
          if (reduced) break;
          fail('The checkpoint did not reduce the prepared request');
        }
        log.append(
          {
            type: 'context-replace',
            replacements: [{ start: 0, deleteCount: cut, insert: [summary] }],
          },
          projection.leafId,
        );
        projection = log.context();
        request = next;
        occupancy = measured;
        reduced = true;
        if (occupancy.total <= target) break;
      }
    } catch (error) {
      signal.throwIfAborted();
      const issue = error instanceof Error ? error.message : String(error);
      if (manual) fail(issue);
      if ((repair && !pruned && !reduced) || (budget !== undefined && occupancy.total > budget)) fail(issue);
    } finally {
      this.operations.delete(id);
      this.notify(id);
    }
    if (repair && !pruned && !reduced) fail('No further reduction is possible');
    if (budget !== undefined && occupancy.total > budget && !manual)
      fail('The prepared request exceeds the available input budget after compaction');
    return request;
  }
}
