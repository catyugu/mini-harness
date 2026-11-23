export interface TabScope { workspaceId: string; sessionId?: string }
export interface TabAddress extends TabScope { type: string; path?: string }
export interface RightTabType {
  title(address: TabAddress): string;
  create(address: TabAddress, signal: AbortSignal): HTMLElement;
  default?: boolean;
}

/** Browser plugin contract; independent from the concrete right panel implementation. */
export interface RightTabsPort {
  register(type: string, definition: RightTabType): () => void;
  open(type: string, path?: string, scope?: TabScope): void;
  inspect(owner: string, title: string, node: HTMLElement, signal: AbortSignal): void;
}
