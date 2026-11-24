export interface ComposerCommand {
  name: string;
  description: string;
  group?: string;
  /** Additional prefixes that find this command in the palette. */
  aliases?: readonly string[];
  /** With no callback the palette inserts the command for the next message. */
  run?: () => void | Promise<void>;
}

