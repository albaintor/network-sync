import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunProgress, SyncJob } from './models.js';

export class Storage {
  private writeQueue: Promise<void> = Promise.resolve();
  jobs: SyncJob[] = [];

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(path.join(this.dir, 'history'), { recursive: true });
    this.jobs = await this.read('jobs.json', []);
  }

  private async read<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }

  private async atomicSave(file: string, value: unknown): Promise<void> {
    const destination = path.join(this.dir, file);
    const temp = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(temp, destination);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  saveJobs(): Promise<void> {
    const snapshot = structuredClone(this.jobs);
    const task = this.writeQueue.then(() => this.atomicSave('jobs.json', snapshot));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async getHistory(jobId: string): Promise<RunProgress[]> {
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('Identifiant invalide');
    return this.read(path.join('history', jobId + '.json'), []);
  }

  async addHistory(run: RunProgress): Promise<void> {
    const history = await this.getHistory(run.jobId);
    history.unshift(structuredClone(run));
    await this.atomicSave(path.join('history', run.jobId + '.json'), history.slice(0, 30));
  }
}
