import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/plugin-api/profile';
import type { Context } from 'mini-harness/cordis';
import { SettingsManager } from './manager.js';

export default {
  inject: ['harnessState', 'harnessProfile'],
  provide: ['harnessSettingsStore'],
  apply(ctx: Context) {
    const settings = new SettingsManager(ctx.harnessProfile, () => ctx.get('harnessComposition')!);
    ctx.provide('harnessSettingsStore', settings);
    ctx.on('harness/drain', () => settings.close());
  },
};
