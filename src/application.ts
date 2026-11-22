/** Application composition root: the only host module that imports feature implementations. */
import type { Paths } from './config.js';
import { MiniHarnessRuntime as CoreRuntime } from './kernel/runtime.js';
import { builtins } from '../features/index.js';
import { Delegation } from '../features/subagents/delegation.js';

export class MiniHarnessRuntime extends CoreRuntime {
  constructor(paths: Paths) {
    super(paths, { builtins, createDelegation: (registry, pi, runs, policy, available) =>
      new Delegation(registry, pi, runs, policy, available) });
  }
}
