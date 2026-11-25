import { FiberState, Inject, type Context, type Fiber, type Plugin } from '../index.js'

// Loader config is JSON data. Object key order has no effect on activation.
function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameData(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if ([left, right].some(value => {
    const prototype = Object.getPrototypeOf(value)
    return prototype !== null && prototype !== Object.prototype
  })) return false
  const entries = Object.entries(left)
  return entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => Object.hasOwn(right, key) && sameData(value, Reflect.get(right, key)))
}

/** An in-memory loader entry. The host supplies module resolution and its scope. */
export interface EntryOptions {
  id: string
  context: Context
  /** Changes to the module or its resource declarations replace the entry. */
  module: string
  load(): Plugin | Promise<Plugin>
  config: Record<string, unknown>
  inject?: Inject
  live?: boolean
  prepare?(ctx: Context): void | Promise<void>
  verify?(ctx: Context): void | Promise<void>
}

export class Entry {
  fiber?: Fiber
  private failure?: unknown

  constructor(public options: EntryOptions) {}

  get active() {
    return this.fiber?.state === FiberState.ACTIVE
  }

  get error() {
    return this.failure ?? this.fiber?.error
  }

  matches(options: EntryOptions) {
    const previous = this.options
    return previous.context === options.context && previous.module === options.module &&
      Boolean(previous.live) === Boolean(options.live) &&
      sameData(Inject.resolve(previous.inject), Inject.resolve(options.inject))
  }

  async start() {
    this.failure = undefined
    try {
      const plugin = await this.options.load()
      this.fiber = this.options.context.registry.plugin(plugin, this.options.config, undefined, this).ctx.fiber
    } catch (error) {
      this.failure = error
    }
  }

  async update(options: EntryOptions) {
    const previous = this.options
    this.options = options
    if (!this.fiber) return this.start()
    if (!this.error && sameData(previous.config, options.config)) return
    this.failure = undefined
    try {
      await this.fiber.update(options.config, true)
    } catch (error) {
      this.failure = error
    }
  }

  async stop() {
    await this.fiber?.dispose()
  }
}
