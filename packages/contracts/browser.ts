/** Browser plugin graph wire contract; independent of any UI renderer or Host implementation. */
export interface BrowserEntry {
  id: string;
  browser?: string;
  web?: boolean;
  required?: boolean;
  config: Record<string, unknown>;
  requires?: string[];
}
