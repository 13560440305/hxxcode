export type TextPart = {
  type: "text";
  id: string;
  text: string;
};

export type ImagePart = {
  type: "image";
  id: string;
  mime: string;
  name: string;
  /** data:image/...;base64,... */
  dataUrl?: string;
  path?: string;
};

export type FilePart = {
  type: "file";
  id: string;
  mime: string;
  name: string;
  path?: string;
  textContent?: string;
};

export type MessagePart = TextPart | ImagePart | FilePart;

export function newPartId(): string {
  return crypto.randomUUID();
}
