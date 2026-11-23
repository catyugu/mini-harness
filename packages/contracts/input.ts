/** Browser-safe attachment and image input contract. */
export interface Attachment { name: string; mimeType: string; data: string }
export interface ImageInput { type: 'image'; mimeType: string; data: string }
