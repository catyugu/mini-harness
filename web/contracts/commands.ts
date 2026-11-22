export interface ComposerCommand {
  name: string;
  description: string;
  group?: string;
  /** With no callback the palette inserts the command for the next message. */
  run?: () => void | Promise<void>;
}

