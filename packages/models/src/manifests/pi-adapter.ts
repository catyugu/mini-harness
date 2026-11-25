import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { PiLlm } from '../server/pi-adapter.ts';

export const metadata: PluginInfo = {
  title: 'Pi model adapter',
  description: 'Model streaming via the Pi SDK',
};

const plugin: Plugin.Object = {
  inject: ['harnessLlm', 'harnessModelStore'],
  apply(ctx) {
    ctx.effect(() => ctx.harnessLlm.register(new PiLlm(ctx.harnessModelStore), -1));
  },
};

export default plugin;
