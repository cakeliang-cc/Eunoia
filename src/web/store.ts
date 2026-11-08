/** Durable snapshots for `web_fetch` pagination and history. */

export interface WebDocumentRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly actionId: string | null;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly mimeType: string;
  readonly title: string | null;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly fetchedAt: string;
  readonly sha256: string;
}

export interface WebDocumentStore {
  saveWebDocument(record: WebDocumentRecord): Promise<void>;
  getWebDocument(userId: string, id: string): Promise<WebDocumentRecord | null>;
}
