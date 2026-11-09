export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';
export type CompareMode = 'size' | 'sha256';
export type TransferMode = 'copy' | 'move' | 'duplicates';
export type DestinationLayout = 'tree' | 'flat';

export interface SizeFilter {
  operator: 'gt' | 'lt';
  megabytes: number;
}

export interface SyncJob {
  id: string;
  name: string;
  sources: string[];
  destination: string;
  conflictPolicy: ConflictPolicy;
  compareMode: CompareMode;
  /** Defaults to copy for previously saved jobs. */
  operation?: TransferMode;
  /** Defaults to preserving each source's relative paths. */
  layout?: DestinationLayout;
  /** null/undefined = all files; non-empty list = allowed filename extensions. */
  extensions?: string[] | null;
  /** Optional strict threshold (MiB), no filtering on older rules. */
  sizeFilter?: SizeFilter | null;
  /** JavaScript regular expression tested on the basename (not the path). */
  filenameRegex?: string | null;
  filenameRegexIgnoreCase?: boolean;
  cron: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

export interface RunProgress {
  id: string;
  jobId: string;
  jobName: string;
  operation?: TransferMode;
  dryRun: boolean;
  status: RunStatus;
  phase: 'scanning' | 'hashing' | 'copying' | 'finished';
  startedAt: string;
  finishedAt?: string;
  filesTotal: number;
  /** Candidates sharing a size, subject to SHA-256 verification. */
  candidateFiles?: number;
  /** Groups confirmed by content hash. */
  duplicateGroups?: number;
  bytesTotal: number;
  /** Estimated bytes needing copy; adjusted as conflicts and errors are resolved. */
  bytesToTransfer?: number;
  /** Successfully copied bytes + current in-progress file bytes. */
  bytesTransferred?: number;
  /** Bytes streamed for the active file (not yet committed). */
  currentFileBytes?: number;
  currentFileSize?: number | null;
  transferStartedAt?: string;
  /** Measured throughput, smoothed over recent streamed chunks. */
  transferSpeedBytesPerSec?: number | null;
  /** Approximate ETA for remaining data, not including future hashing overhead. */
  transferEtaSeconds?: number | null;
  lastTransferAtMs?: number;
  processed: number;
  bytesCopied: number;
  copied: number;
  /** Source files removed (or that would be removed in a simulation). */
  moved?: number;
  skipped: number;
  /** Files excluded by any file filter during source scanning. */
  excluded?: number;
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
