import type { Context } from 'cordis';
import { SlotRegistry } from './registry.js';

const setup = (ctx: Context) => { ctx.provide('miniSlots', new SlotRegistry()); };
export default setup;
