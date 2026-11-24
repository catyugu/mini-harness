/** A configuration handle whose namespace and lifetime are bound by the host. */
export interface PluginConfiguration {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
  /** Apply a shallow field patch as one transaction. */
  patch(values: Record<string, unknown>): Promise<void>;
  subscribe<T = unknown>(key: string, listener: (value: T) => void): () => void;
}
