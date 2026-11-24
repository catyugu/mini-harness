/** Public services that plugins can explicitly inject or provide. */
export interface ServiceMap {}

/** A single augmentation also types the native Cordis context. */
declare module 'cordis' {
  interface Context extends ServiceMap {}
}
