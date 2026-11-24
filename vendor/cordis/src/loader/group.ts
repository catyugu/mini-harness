import type { Context } from '../context.js'

/** Shared context for entries inheriting the same parent and service isolation. */
export class EntryGroup {
  readonly context: Context

  constructor(readonly parent: Context, readonly isolated: readonly string[]) {
    this.context = isolated.reduce((ctx, name) => ctx.isolate(name), parent.extend())
  }

  matches(parent: Context, isolated: readonly string[]) {
    return this.parent === parent && this.isolated.length === isolated.length &&
      this.isolated.every((name, index) => name === isolated[index])
  }
}
