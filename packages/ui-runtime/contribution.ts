import type { Context } from 'cordis';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';

export type BrowserRelease = () => void | Promise<void>;

export interface BrowserContributionSource {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly configuration: PluginConfiguration;
  service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]>;
  effect(install: () => BrowserRelease): BrowserRelease;
}
export type BrowserContribution<Args extends unknown[], Result> =
  (source: BrowserContributionSource, ...args: Args) => Result;
