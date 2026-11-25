import type { Context } from 'mini-harness/cordis';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import { DomainError } from '@mini-harness/platform/errors';
import {
  assertOutsideMountTransaction,
  assertOutsidePluginRequest,
  type MutationPort,
} from '@mini-harness/plugin-api/mutation-api';

/** One transaction gate for HTTP settings and installed plugin operations. */
export class MutationGate implements MutationPort {
  private active?: Promise<unknown>;
  private closing = false;
  private readonly structural = new Set<{ scopes?: ReadonlySet<ScopeKey> }>();

  private readonly guards = new Set<(scopes?: ReadonlySet<ScopeKey>, fibers?: ReadonlySet<Context['fiber']>) => void>();

  guard(check: (scopes?: ReadonlySet<ScopeKey>, fibers?: ReadonlySet<Context['fiber']>) => void) {
    this.guards.add(check);
    return () => {
      this.guards.delete(check);
    };
  }

  seal() {
    this.closing = true;
  }

  protect(scopes?: ReadonlySet<ScopeKey>, fibers?: ReadonlySet<Context['fiber']>) {
    for (const check of this.guards) check(scopes, fibers);
    const guard = { scopes };
    this.structural.add(guard);
    return () => {
      this.structural.delete(guard);
    };
  }

  admit(scopeKeys: readonly ScopeKey[]) {
    assertOutsideMountTransaction();
    if (this.closing) throw new DomainError('unavailable', 'Application is closing');
    if ([...this.structural].some(({ scopes }) => !scopes || scopeKeys.some((key) => scopes.has(key))))
      throw new DomainError('conflict', 'Resource configuration is changing; try again when it finishes');
  }
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    assertOutsideMountTransaction();
    if (this.closing) throw new DomainError('unavailable', 'Application is closing');
    assertOutsidePluginRequest();
    if (this.active) throw new DomainError('conflict', 'Configuration is already changing');
    const work = Promise.resolve().then(operation);
    this.active = work;
    try {
      return await work;
    } finally {
      this.active = undefined;
    }
  }

  drain() {
    return Promise.allSettled(this.active ? [this.active] : []);
  }
}
