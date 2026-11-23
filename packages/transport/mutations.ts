import type { MutationPort } from '#mini-harness/contracts/routes.js';

/** One transaction gate for HTTP settings and installed plugin operations. */
export class MutationGate implements MutationPort {
  private busy = false;
  get changing() { return this.busy; }
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.busy) throw new Error('Configuration is already changing');
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
}
