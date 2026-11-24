import { DomainError } from '@mini-harness/platform/errors';
import { type MutationPort } from '@mini-harness/contracts/routes';

/** One transaction gate for HTTP settings and installed plugin operations. */
export class MutationGate implements MutationPort {
  private active?: Promise<unknown>;
  private closing = false;
  private readonly structural = new Set<{ scopes?: ReadonlySet<string> }>();

  constructor(private readonly hasWork: (scopes?: ReadonlySet<string>) => boolean) {}

  protect(scopes?: ReadonlySet<string>) {
    if (this.hasWork(scopes)) throw new DomainError('conflict', 'Stop the affected conversations before changing their providers or plugins');
    const guard = { scopes };
    this.structural.add(guard);
    return () => { this.structural.delete(guard); };
  }

  admit(scopeKeys: readonly string[]) {
    if (this.closing) throw new DomainError('unavailable', 'Application is closing');
    if ([...this.structural].some(({ scopes }) => !scopes || scopeKeys.some((key) => scopes.has(key))))
      throw new DomainError('conflict', 'Conversation configuration is changing; try again when it finishes');
  }
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closing) throw new DomainError('unavailable', 'Application is closing');
    if (this.active) throw new DomainError('conflict', 'Configuration is already changing');
    const work = Promise.resolve().then(operation);
    this.active = work;
    try { return await work; }
    finally { this.active = undefined; }
  }

  close() {
    this.closing = true;
    return Promise.allSettled(this.active ? [this.active] : []);
  }
}
