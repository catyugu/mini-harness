import type {} from 'cordis';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';

declare module 'cordis' {
  interface Context { miniAppearance: PluginConfiguration }
}
