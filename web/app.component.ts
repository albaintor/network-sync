import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

type ConflictPolicy = 'rename' | 'skip' | 'overwrite';
type CompareMode = 'size' | 'sha256';
interface Job {
  id: string; name: string; sources: string[]; destination: string;
  conflictPolicy: ConflictPolicy; compareMode: CompareMode;
  cron: string | null; enabled: boolean; updatedAt: string;
}
interface JobForm {
  name: string; sources: string[]; destination: string;
  conflictPolicy: ConflictPolicy; compareMode: CompareMode; cron: string; enabled: boolean;
}
interface Run {
  id: string; jobId: string; jobName: string; status: string;
  phase: string; dryRun: boolean; startedAt: string; finishedAt?: string;
  filesTotal: number; bytesTotal: number; processed: number;
  bytesCopied: number; copied: number; skipped: number; renamed: number;
  overwritten: number; errors: number; errorMessages: string[]; currentFile: string | null;
}

@Component({
  selector: 'ns-app',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;
  jobs: Job[] = [];
  selectedId: string | null = null;
  active: Run | null = null;
  history: Run[] = [];
  error = '';
  loading = true;
  saving = false;
  formVisible = false;
  editingId: string | null = null;
  form: JobForm = this.blankForm();
  browseKind: 'source' | 'destination' | null = null;
  browseIndex = -1;
  browsePath: string | null = null;
  directories: { path: string; name: string }[] = [];
  browseLoading = false;
  timezone = 'Europe/Paris';
  sourceRoots: string[] = [];
  destinationRoots: string[] = [];

  get selected(): Job | undefined { return this.jobs.find(j => j.id === this.selectedId); }
  get selectedRun(): Run | null { return this.active?.jobId === this.selectedId ? this.active : null; }

  ngOnInit(): void {
    this.load();
    this.pollStatus();
    this.timer = setInterval(() => this.pollStatus(), 1500);
    this.http.get<{ timezone: string; roots: { sources: string[]; destinations: string[] } }>('/api/settings').subscribe({
      next: data => { this.timezone = data.timezone; this.sourceRoots = data.roots.sources; this.destinationRoots = data.roots.destinations; },
      error: e => this.showError(e)
    });
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private blankForm(): JobForm {
    return { name: '', sources: [''], destination: '', conflictPolicy: 'rename',
      compareMode: 'size', cron: '', enabled: true };
  }

  private showError(error: unknown): void {
    const err = error as HttpErrorResponse;
    this.error = (err.error && typeof err.error.error === 'string')
      ? err.error.error : (err.message ?? String(error));
  }

  load(): void {
    this.http.get<{ jobs: Job[] }>('/api/jobs').subscribe({
      next: data => {
        this.jobs = data.jobs;
        if (!this.selectedId || !this.jobs.some(j => j.id === this.selectedId)) {
          this.selectedId = this.jobs[0]?.id ?? null;
        }
        this.loading = false;
        this.loadHistory();
      },
      error: e => { this.loading = false; this.showError(e); }
    });
  }
  pollStatus(): void {
    this.http.get<{ active: Run | null }>('/api/status').subscribe({
      next: data => {
        const wasRunning = this.active !== null;
        this.active = data.active;
        if (wasRunning && !this.active) this.loadHistory();
      }
    });
  }
  select(job: Job): void { this.selectedId = job.id; this.loadHistory(); }
  loadHistory(): void {
    const id = this.selectedId;
    if (!id) { this.history = []; return; }
    this.http.get<{ runs: Run[] }>('/api/jobs/' + encodeURIComponent(id) + '/runs').subscribe({
      next: response => { if (id === this.selectedId) this.history = response.runs; },
      error: e => this.showError(e)
    });
  }
  edit(job?: Job): void {
    this.error = '';
    this.editingId = job?.id ?? null;
    this.form = job
      ? { name: job.name, sources: [...job.sources], destination: job.destination,
          conflictPolicy: job.conflictPolicy, compareMode: job.compareMode,
          cron: job.cron ?? '', enabled: job.enabled }
      : this.blankForm();
    this.formVisible = true;
  }
  addSource(): void { if (this.form.sources.length < 30) this.form.sources.push(''); }
  removeSource(index: number): void {
    if (this.form.sources.length > 1) this.form.sources.splice(index, 1);
  }
  save(): void {
    if (this.saving) return;
    this.error = '';
    if (!this.form.name.trim() || this.form.sources.some(x => !x.trim()) || !this.form.destination.trim()) {
      this.error = 'Veuillez renseigner le nom, toutes les sources et la destination.';
      return;
    }
    this.saving = true;
    const body = { ...this.form, sources: this.form.sources.map(x => x.trim()),
      destination: this.form.destination.trim(), cron: this.form.cron.trim() || null };
    const id = this.editingId;
    const request = id ? this.http.put<{ job: Job }>('/api/jobs/' + id, body)
      : this.http.post<{ job: Job }>('/api/jobs', body);
    request.subscribe({
      next: data => { this.saving = false; this.formVisible = false; this.selectedId = data.job.id; this.load(); },
      error: e => { this.saving = false; this.showError(e); }
    });
  }
  remove(job: Job): void {
    if (!confirm('Supprimer la configuration « ' + job.name + ' » ? Les fichiers synchronisés ne seront pas supprimés.')) return;
    this.error = '';
    this.http.delete('/api/jobs/' + job.id).subscribe({
      next: () => { this.selectedId = null; this.load(); },
      error: e => this.showError(e)
    });
  }
  run(job: Job, dryRun: boolean): void {
    if (this.active) return;
    this.error = '';
    this.http.post<{ run: Run }>('/api/jobs/' + job.id + '/run', { dryRun }).subscribe({
      next: data => { this.active = data.run; this.selectedId = job.id; },
      error: e => this.showError(e)
    });
  }
  cancel(job: Job): void {
    this.http.post('/api/jobs/' + job.id + '/cancel', {}).subscribe({
      error: e => this.showError(e)
    });
  }
  openBrowser(kind: 'source' | 'destination', index = -1): void {
    this.browseKind = kind; this.browseIndex = index; this.browsePath = null;
    this.listDirectories();
  }
  listDirectories(directory?: string): void {
    if (!this.browseKind) return;
    this.browseLoading = true;
    const params: Record<string, string> = { kind: this.browseKind };
    if (directory) params['path'] = directory;
    this.http.get<{ directories: { path: string; name: string }[] }>('/api/browse', { params }).subscribe({
      next: data => {
        this.directories = data.directories;
        this.browsePath = directory ?? null;
        this.browseLoading = false;
      },
      error: e => { this.browseLoading = false; this.showError(e); }
    });
  }
  browseUp(): void {
    if (!this.browsePath) return;
    const roots = this.browseKind === 'source' ? this.sourceRoots : this.destinationRoots;
    if (roots.includes(this.browsePath)) { this.listDirectories(); return; }
    const parent = this.browsePath.slice(0, this.browsePath.lastIndexOf('/')) || '/';
    // Returning to the list of authorized roots never traverses outside them.
    this.listDirectories(parent === '/' ? undefined : parent);
  }
  chooseFolder(): void {
    if (!this.browsePath) return;
    if (this.browseKind === 'destination') this.form.destination = this.browsePath;
    else this.form.sources[this.browseIndex] = this.browsePath;
    this.browseKind = null;
  }
  formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' o';
    const units = ['Ko', 'Mo', 'Go', 'To', 'Po'];
    let v = bytes, n = -1;
    do { v /= 1024; n++; } while (v >= 1024 && n < units.length - 1);
    return v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' ' + units[n];
  }
  date(value: string): string {
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }
  statusLabel(value: string): string {
    return ({ completed: 'Terminé', completed_with_errors: 'Terminé avec erreurs',
      failed: 'Échec', cancelled: 'Annulé', running: 'En cours' } as Record<string, string>)[value] ?? value;
  }
  policyLabel(value: ConflictPolicy): string {
    return ({ rename: 'Renommer les conflits', skip: 'Ignorer les conflits',
      overwrite: 'Remplacer les conflits' })[value];
  }
  percentage(run: Run): number {
    return run.filesTotal ? Math.round(100 * run.processed / run.filesTotal) : 0;
  }
}
