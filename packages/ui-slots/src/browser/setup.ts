import type { Context } from 'mini-harness/cordis';
import { SlotRegistry } from './registry.js';

const setup = (ctx: Context) => {
  ctx.provide('miniSlots', new SlotRegistry());
};
export default { inject: [], provide: ['miniSlots'], apply: setup };
