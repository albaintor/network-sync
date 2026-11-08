export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';
export type CompareMode = 'size' | 'sha256';

export interface SyncJob {
  id: string;
  name: string;
  sources: string[];
  destination: string;
  conflictPolicy: ConflictPolicy;
  compareMode: CompareMode;
  cron: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

export interface RunProgress {
  id: string;
  jobId: string;
  jobName: string;
  dryRun: boolean;
  status: RunStatus;
  phase: 'scanning' | 'copying' | 'finished';
  startedAt: string;
  finishedAt?: string;
  filesTotal: number;
  bytesTotal: number;
  processed: number;
  bytesCopied: number;
  copied: number;
  skipped: number;
  renamed: number;
  overwritten: number;
  errors: number;
  errorMessages: string[];
  currentFile: string | null;
}

export interface Roots {
  sources: string[];
  destinations: string[];
}
