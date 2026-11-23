import { HttpError, type MutationPort } from '@mini-harness/contracts/routes';

/** One transaction gate for HTTP settings and installed plugin operations. */
export class MutationGate implements MutationPort {
  private busy = false;
  private readonly structural = new Set<{ scopes?: ReadonlySet<string> }>();

  constructor(private readonly hasWork: (scopes?: ReadonlySet<string>) => boolean) {}

  protect(scopes?: ReadonlySet<string>) {
    if (this.hasWork(scopes)) throw new HttpError('conflict', 'Stop the affected conversations before changing their providers or plugins');
    const guard = { scopes };
    this.structural.add(guard);
    return () => { this.structural.delete(guard); };
  }

  admit(scopeKeys: readonly string[]) {
    if ([...this.structural].some(({ scopes }) => !scopes || scopeKeys.some((key) => scopes.has(key))))
      throw new HttpError('conflict', 'Conversation configuration is changing; try again when it finishes');
  }
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.busy) throw new HttpError('conflict', 'Configuration is already changing');
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
}
