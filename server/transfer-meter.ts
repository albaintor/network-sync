import type { RunProgress } from './models.js';

/**
 * Live, best-effort transfer metrics. The total starts from all filtered
 * source bytes, then shrinks as conflicts/skips and failures are discovered.
 * Only source-to-temp streaming is sampled: hashing, USB publication fallback
 * and source deletion may add time that a byte-based ETA cannot predict.
 */
export class TransferMeter {
  private windowStartedAt: number | null = null;
  private windowBytes = 0;
  private previousChunkAt: number | null = null;
  private smoothedRate: number | null = null;
  private lastNotification = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly progress: RunProgress,
    private readonly onUpdate: () => void = () => {},
    private readonly now: () => number = () => performance.now()
  ) {}

  begin(): void {
    this.progress.bytesToTransfer = this.progress.bytesTotal;
    this.progress.bytesTransferred = this.progress.bytesCopied;
    this.progress.currentFileBytes = 0;
    this.progress.currentFileSize = null;
    this.progress.transferSpeedBytesPerSec = null;
    this.progress.transferEtaSeconds = null;
    this.progress.transferStartedAt = new Date().toISOString();
  }

  beginFile(size: number): void {
    this.progress.currentFileSize = size;
    this.progress.currentFileBytes = 0;
    this.updateEstimate();
  }

  /**
   * Called as chunks traverse the streaming pipeline. Node backpressure
   * ensures this generally follows the destination writer's actual speed.
   */
  chunk(size: number): void {
    if (size <= 0) return;
    const now = this.now();
    if (this.previousChunkAt !== null && now - this.previousChunkAt > 10_000) {
      // Pause or a long I/O stall: discard the stale rate.
      this.windowStartedAt = null;
      this.windowBytes = 0;
      this.smoothedRate = null;
      this.progress.transferSpeedBytesPerSec = null;
    }
    if (this.windowStartedAt === null) this.windowStartedAt = now;
    this.previousChunkAt = now;
    this.windowBytes += size;
    this.progress.currentFileBytes = Math.min(
      this.progress.currentFileSize ?? Number.MAX_SAFE_INTEGER,
      (this.progress.currentFileBytes ?? 0) + size
    );
    this.progress.lastTransferAtMs = Date.now();
    const windowDuration = now - this.windowStartedAt;
    if (windowDuration >= 1_000) {
      const sampleRate = (this.windowBytes * 1000) / windowDuration;
      if (Number.isFinite(sampleRate) && sampleRate > 0) {
        this.smoothedRate = this.smoothedRate === null
          ? sampleRate : (this.smoothedRate * 0.7 + sampleRate * 0.3);
        this.progress.transferSpeedBytesPerSec = Math.round(this.smoothedRate);
      }
      this.windowBytes = 0;
      this.windowStartedAt = now;
    }
    this.updateEstimate();
    if (now - this.lastNotification >= 350) {
      this.lastNotification = now;
      this.onUpdate();
    }
  }

  /**
   * The engine must update bytesCopied before marking a file complete.
   */
  completeFile(): void {
    this.progress.currentFileBytes = 0;
    this.progress.currentFileSize = null;
    this.updateEstimate();
  }

  skip(size: number): void {
    this.progress.bytesToTransfer = Math.max(
      this.progress.bytesCopied,
      (this.progress.bytesToTransfer ?? 0) - size
    );
    this.updateEstimate();
  }

  fail(size: number): void {
    this.progress.currentFileBytes = 0;
    this.progress.currentFileSize = null;
    this.skip(size);
  }

  finish(): void {
    this.progress.currentFileBytes = 0;
    this.progress.currentFileSize = null;
    this.progress.bytesTransferred = this.progress.bytesCopied;
    this.progress.transferEtaSeconds = null;
  }

  private updateEstimate(): void {
    this.progress.bytesTransferred = this.progress.bytesCopied + (this.progress.currentFileBytes ?? 0);
    const left = Math.max(0, (this.progress.bytesToTransfer ?? 0) - this.progress.bytesTransferred);
    const rate = this.progress.transferSpeedBytesPerSec;
    this.progress.transferEtaSeconds = rate && rate > 0 ? Math.ceil(left / rate) : null;
  }
}
