/** Browser plugin graph wire contract; independent of any UI renderer or Host implementation. */
export interface BrowserEntry {
  id: string;
  browser: string;
  requires?: string[];
}
