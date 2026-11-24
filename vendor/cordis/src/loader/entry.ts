import { FiberState, type Context, type Fiber, type Inject, type Plugin } from '../index.js'

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
    if (!this.error && JSON.stringify(previous.config) === JSON.stringify(options.config)) return
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
