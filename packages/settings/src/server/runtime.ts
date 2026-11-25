import type { Context } from 'mini-harness/cordis';
import { SettingsManager } from './manager.ts';

export default {
  inject: ['harnessProfile'],
  provide: ['harnessSettingsStore'],
  apply(ctx: Context) {
    const settings = new SettingsManager(ctx.harnessProfile, () => ctx.get('harnessComposition'));
    ctx.provide('harnessSettingsStore', settings);
    ctx.on('harness/drain', () => settings.close());
  },
};
