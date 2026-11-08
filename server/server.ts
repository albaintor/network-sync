import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cron, { type ScheduledTask } from 'node-cron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browseDirectories, destinationRootFor, ensureDestinationDirectory, getRoots, validateJobPaths, ValidationError } from './security.js';
import { executeSync, newProgress } from './engine.js';
import { normalizeExtensions } from './extensions.js';
import { PauseGate } from './pause.js';
import { Storage } from './storage.js';
import type { CompareMode, ConflictPolicy, RunProgress, SyncJob } from './models.js';

const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT ?? '8080');
const username = process.env.APP_USERNAME;
const password = process.env.APP_PASSWORD;
if (!username || !password || password.length < 12) {
  throw new Error('APP_USERNAME et APP_PASSWORD (12 caractères minimum) sont obligatoires.');
}

const roots = getRoots();
const storage = new Storage(process.env.DATA_DIR ?? './data');
await storage.init();

function equals(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon > -1 && equals(decoded.slice(0, colon), username) && equals(decoded.slice(colon + 1), password)) {
        return next();
      }
    } catch { /* Fall through to 401. */ }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Network Sync", charset="UTF-8"');
  return res.status(401).json({ error: 'Authentification requise' });
});
app.use('/api', express.json({ limit: '64kb' }));

const schedules = new Map<string, ScheduledTask>();
let active: { jobId: string; progress: RunProgress; controller: AbortController; gate: PauseGate } | null = null;

function apiError(res: Response, error: unknown): void {
  const code = error instanceof ValidationError ? 400 : 500;
  const message = error instanceof Error ? error.message : String(error);
  console.error('Network Sync:', message);
  res.status(code).json({ error: code === 500 ? 'Erreur serveur : ' + message : message });
}

function route(fn: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => { void fn(req, res).catch(next); };
}

function jobById(id: string): SyncJob | undefined {
  return storage.jobs.find(job => job.id === id);
}

function parseJob(input: unknown, old?: SyncJob): SyncJob {
  if (!input || typeof input !== 'object') throw new ValidationError('Corps JSON invalide.');
  const obj = input as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name || name.length > 100) throw new ValidationError('Le nom doit contenir 1 à 100 caractères.');
  if (!Array.isArray(obj.sources) || obj.sources.length < 1 || obj.sources.length > 30 ||
      obj.sources.some(x => typeof x !== 'string' || x.length > 2048 || !x.trim())) {
    throw new ValidationError('Veuillez renseigner 1 à 30 sources valides.');
  }
  if (typeof obj.destination !== 'string' || !obj.destination.trim() || obj.destination.length > 2048) {
    throw new ValidationError('Destination invalide.');
  }
  const conflict = obj.conflictPolicy ?? 'rename';
  if (!['rename', 'skip', 'overwrite'].includes(String(conflict))) throw new ValidationError('Règle de conflit inconnue.');
  const compare = obj.compareMode ?? 'size';
  if (!['size', 'sha256'].includes(String(compare))) throw new ValidationError('Mode de comparaison inconnu.');
  const schedule = typeof obj.cron === 'string' ? obj.cron.trim() : '';
  if (schedule && !cron.validate(schedule)) throw new ValidationError('Expression cron invalide.');
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    throw new ValidationError('Le champ activé doit être booléen.');
  }
  if (!(obj.sources as string[]).every(x => path.isAbsolute(x.trim())) || !path.isAbsolute(obj.destination.trim())) {
    throw new ValidationError('Les chemins doivent être absolus.');
  }
  const now = new Date().toISOString();
  return {
    id: old?.id ?? randomUUID(),
    name,
    sources: (obj.sources as string[]).map(x => path.resolve(x.trim())),
    destination: path.resolve(obj.destination.trim()),
    conflictPolicy: conflict as ConflictPolicy,
    compareMode: compare as CompareMode,
    extensions: obj.extensions === undefined ? (old?.extensions ?? null) : normalizeExtensions(obj.extensions),
    cron: schedule || null,
    enabled: obj.enabled === undefined ? true : obj.enabled,
    createdAt: old?.createdAt ?? now,
    updatedAt: now
  };
}

function launch(job: SyncJob, dryRun: boolean): RunProgress {
  if (active) throw new ValidationError('Une synchronisation est déjà en cours : ' + active.progress.jobName);
  const controller = new AbortController();
  const gate = new PauseGate();
  const progress = newProgress(job, dryRun);
  active = { jobId: job.id, progress, controller, gate };
  void executeSync(job, progress, roots, controller.signal, () => {}, gate)
    .then(() => storage.addHistory(progress))
    .catch(error => console.error('Impossible de sauvegarder l’historique :', error))
    .finally(() => { active = null; });
  return progress;
}

function scheduleJob(job: SyncJob): void {
  schedules.get(job.id)?.stop();
  schedules.delete(job.id);
  if (!job.enabled || !job.cron || !cron.validate(job.cron)) return;
  schedules.set(job.id, cron.schedule(job.cron, () => {
    if (!active) launch(job, false);
    else console.warn('Synchronisation planifiée ignorée : une autre tâche est déjà en cours :', job.name);
  }, { timezone: process.env.TZ ?? 'Europe/Paris', noOverlap: true }));
}

for (const job of storage.jobs) scheduleJob(job);

app.get('/api/settings', (_req, res) => res.json({ roots, timezone: process.env.TZ ?? 'Europe/Paris' }));
app.get('/api/jobs', (_req, res) => res.json({ jobs: storage.jobs }));
app.get('/api/status', (_req, res) => res.json({ active: active?.progress ?? null }));

app.get('/api/browse', route(async (req, res) => {
  const kind = req.query.kind;
  if (kind !== 'source' && kind !== 'destination') throw new ValidationError('Type de navigation invalide.');
  const requested = req.query.path;
  if (requested !== undefined && typeof requested !== 'string') throw new ValidationError('Chemin invalide.');
  const candidates = kind === 'source' ? roots.sources : roots.destinations;
  const dirs = await browseDirectories(candidates, requested);
  res.json({ directories: dirs });
}));

// Create a destination subfolder from the browser, but never outside mounted roots.
app.post('/api/folders', route(async (req, res) => {
  const parent = req.body?.parent;
  const name = req.body?.name;
  if (typeof parent !== 'string' || typeof name !== 'string' ||
      !name.trim() || name.length > 255 || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new ValidationError('Nom de dossier ou chemin parent invalide.');
  }
  const root = await destinationRootFor(parent, roots);
  // Parent must exist and be a real directory (no symlink traversal).
  await browseDirectories(roots.destinations, parent);
  const folder = path.join(parent, name);
  await ensureDestinationDirectory(root, folder, true);
  res.status(201).json({ path: folder });
}));

app.post('/api/jobs', route(async (req, res) => {
  const job = parseJob(req.body);
  await validateJobPaths(job, roots);
  storage.jobs.push(job);
  await storage.saveJobs();
  scheduleJob(job);
  res.status(201).json({ job });
}));

app.put('/api/jobs/:id', route(async (req, res) => {
  const previous = jobById(req.params.id);
  if (!previous) { res.status(404).json({ error: 'Tâche introuvable' }); return; }
  if (active?.jobId === previous.id) { res.status(409).json({ error: 'Tâche en cours de synchronisation' }); return; }
  const job = parseJob(req.body, previous);
  await validateJobPaths(job, roots);
  storage.jobs[storage.jobs.findIndex(item => item.id === previous.id)] = job;
  await storage.saveJobs();
  scheduleJob(job);
  res.json({ job });
}));

app.delete('/api/jobs/:id', route(async (req, res) => {
  const job = jobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'Tâche introuvable' }); return; }
  if (active?.jobId === job.id) { res.status(409).json({ error: 'Tâche en cours de synchronisation' }); return; }
  schedules.get(job.id)?.stop();
  schedules.delete(job.id);
  storage.jobs = storage.jobs.filter(item => item.id !== job.id);
  await storage.saveJobs();
  res.status(204).end();
}));

app.get('/api/jobs/:id/runs', route(async (req, res) => {
  if (!jobById(req.params.id)) { res.status(404).json({ error: 'Tâche introuvable' }); return; }
  res.json({ runs: await storage.getHistory(req.params.id) });
}));

app.post('/api/jobs/:id/run', route(async (req, res) => {
  const job = jobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'Tâche introuvable' }); return; }
  if (active) { res.status(409).json({ error: 'Une autre synchronisation est déjà en cours.' }); return; }
  const dryRun = req.body?.dryRun === true;
  res.status(202).json({ run: launch(job, dryRun) });
}));

app.post('/api/jobs/:id/pause', (req, res) => {
  if (!active || active.jobId !== req.params.id) {
    res.status(404).json({ error: 'Aucune synchronisation active pour cette tâche.' });
    return;
  }
  if (active.progress.status !== 'running') {
    res.status(409).json({ error: 'Seule une synchronisation en cours peut être mise en pause.' });
    return;
  }
  active.gate.pause();
  active.progress.status = 'paused';
  res.json({ run: active.progress });
});

app.post('/api/jobs/:id/resume', (req, res) => {
  if (!active || active.jobId !== req.params.id) {
    res.status(404).json({ error: 'Aucune synchronisation active pour cette tâche.' });
    return;
  }
  if (active.progress.status !== 'paused') {
    res.status(409).json({ error: 'Cette synchronisation n’est pas en pause.' });
    return;
  }
  active.progress.status = 'running';
  active.gate.resume();
  res.json({ run: active.progress });
});

app.post('/api/jobs/:id/cancel', (_req, res) => {
  if (!active || active.jobId !== _req.params.id) {
    res.status(404).json({ error: 'Aucune synchronisation en cours pour cette tâche.' });
    return;
  }
  active.controller.abort();
  res.status(202).json({ message: 'Annulation demandée' });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API introuvable' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  apiError(res, error);
});

const frontend = path.resolve('dist/web/browser');
app.use(express.static(frontend, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(frontend, 'index.html')));
app.listen(port, '0.0.0.0', () => {
  console.log('Network Sync listening on ' + port);
  console.log('Mounted NAS roots: ' + roots.sources.join(', '));
});
