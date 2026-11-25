/** Browser-safe attachment and image input contract. */
export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}
export interface ImageInput {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface InputAttachment {
  name: string;
  mimeType: string;
  /** Content identity and original byte count for stored uploads. */
  id?: string;
  size?: number;
}
export interface PreparedMessage {
  userText: string;
  attachments: InputAttachment[];
  /** Original images when preparation changed the model-visible images. */
  images?: ImageInput[];
}

export type InputSource = 'user' | 'agent' | 'plugin';
