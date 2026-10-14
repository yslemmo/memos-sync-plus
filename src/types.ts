export interface Settings {
  serverUrl: string;
  token: string;
  apiMode: 'modern' | 'legacy';
  creator: string;
  syncFolder: string;
  mode: 'daily' | 'individual';
  followDailyNotes: boolean;
  dateFormat: string;
  fileNameFormat: 'id' | 'created' | 'updated' | 'title';
  heading: string;
  templatePath: string;
  bodyTemplate: string;
  noteProperties: boolean;
  historyLimit: number;
  downloadAttachments: boolean;
  attachmentFolder: string;
  maxAttachmentMB: number;
  intervalMinutes: number;
  syncOnStartup: boolean;
  daysLimit: number;
  format: 'list' | 'callout';
  emoji: boolean;
  includeSourceLink: boolean;
  newestFirst: boolean;
  mirrorDeletions: boolean;
  conflictPolicy: 'skip' | 'backup';
}
export const DEFAULT_SETTINGS: Settings = {
  serverUrl: '', token: '', apiMode: 'modern', creator: '',
  syncFolder: 'Memos', mode: 'daily', followDailyNotes: false,
  dateFormat: 'YYYY-MM-DD', fileNameFormat: 'id', heading: 'Memos', templatePath: '',
  bodyTemplate: '', noteProperties: true, historyLimit: 50,
  downloadAttachments: true, attachmentFolder: 'Memos/attachments', maxAttachmentMB: 50,
  intervalMinutes: 0, syncOnStartup: false, daysLimit: 0,
  format: 'list', emoji: true, includeSourceLink: true, newestFirst: false,
  mirrorDeletions: false, conflictPolicy: 'skip'
};
export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}
export interface Memo {
  id: string;
  linkId?: string;
  title?: string;
  tags?: string[];
  created: string;
  updated: string;
  creator: string;
  content: string;
  attachments: Attachment[];
  archived: boolean;
  deleted: boolean;
  comment: boolean;
}
export interface TrackedMemo { path: string; created: string; body: string }
export interface SyncState {
  scope: string;
  memos: Record<string, TrackedMemo>;
  blocks: Record<string, string>;
  properties?: Record<string, string>;
  attachments?: Record<string, string>;
  lastSuccess: string;
}
export const emptyState = (): SyncState => ({ scope: '', memos: {}, blocks: {}, lastSuccess: '' });
export interface SyncReport {
  fetched: number; selected: number; written: number; unchanged: number;
  conflicts: string[]; warnings: string[]; downloaded: number; removed: number; renamed: number;
  failures: SyncFailure[];
  processedMemoIds: string[];
}
export interface SyncFailure { kind: 'attachment' | 'note' | 'rename' | 'conflict'; memoIds: string[]; message: string; path?: string; attachmentId?: string }
export interface PreviewChange { action: 'create' | 'update' | 'rename' | 'attachment' | 'backup' | 'remove'; path: string; from?: string; memoId?: string }
export interface RetrySpec { full: boolean; memoIds: string[]; force?: boolean; day?: string; scope?: string }
export interface HistoryEntry {
  id: string; started: string; ended: string; mode: 'sync' | 'force' | 'day' | 'retry';
  scopeKey: string; status: 'success' | 'partial' | 'failed'; message: string;
  report?: SyncReport; retry: RetrySpec;
  resolved?: boolean;
}
export interface TransportResponse { status: number; text: string; json: unknown; arrayBuffer: ArrayBuffer }
export type Transport = (request: {
  url: string; method: string; headers: Record<string, string>; body?: string;
}) => Promise<TransportResponse>;
export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (current: string) => string): Promise<void>;
  mkdir(path: string): Promise<void>;
  createBinary(path: string, data: ArrayBuffer): Promise<string | void>;
  rename(source: string, destination: string): Promise<void>;
  findBinary?(data: ArrayBuffer, folder: string): Promise<string | undefined>;
  resolveBinary?(path: string): Promise<string | undefined>;
}
