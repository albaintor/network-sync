/**
 * Cooperative pause/resume for directory scanning and streamed copies.
 * Pause state belongs to the current run only and does not survive a restart.
 */
export class PauseGate {
  private paused = false;
  private waiters = new Set<() => void>();

  get isPaused(): boolean { return this.paused; }

  pause(): void { this.paused = true; }

  resume(): void {
    this.paused = false;
    for (const notify of [...this.waiters]) notify();
  }

  wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('Synchronisation annulée.'));
    if (!this.paused) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(wakeup);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(new Error('Synchronisation annulée.')); };
      const wakeup = () => {
        cleanup();
        if (signal.aborted) reject(new Error('Synchronisation annulée.'));
        else resolve();
      };
      this.waiters.add(wakeup);
      signal.addEventListener('abort', onAbort, { once: true });
      // Handle a resume that occurs between the initial check and registering.
      if (!this.paused) wakeup();
    });
  }
}
