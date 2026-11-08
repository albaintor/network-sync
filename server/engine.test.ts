import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeSync, newProgress } from './engine.js';
import type { Roots, SyncJob } from './models.js';

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'network-sync-'));
  const first = path.join(home, 'first');
  const second = path.join(home, 'second');
  const targetRoot = path.join(home, 'target');
  const destination = path.join(targetRoot, 'Photos');
  await Promise.all([mkdir(first), mkdir(second), mkdir(targetRoot)]);
  const roots: Roots = { sources: [first, second], destinations: [targetRoot] };
  const job: SyncJob = {
    id: 'a6ea2615-5b08-4a70-90bf-bb93e0865b02', name: 'Photos',
    sources: [first, second], destination, conflictPolicy: 'rename',
    compareMode: 'size', cron: null, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const put = async (root: string, relative: string, text: string) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const run = async (dryRun = false) => {
    const progress = newProgress(job, dryRun);
    await executeSync(job, progress, roots, new AbortController().signal);
    return progress;
  };
  return { first, second, targetRoot, destination, roots, job, put, run };
}

test('merges multiple sources, preserves hierarchy, renames different sizes, and is idempotent', async () => {
  const { first, second, destination, put, run } = await setup();
  await put(first, '2026/01/photo.jpg', '123');
  await put(second, '2026/01/photo.jpg', '123456789');
  const initial = await run();
  assert.equal(initial.status, 'completed');
  assert.equal(initial.copied, 2);
  assert.equal(initial.renamed, 1);
  const folder = path.join(destination, '2026/01');
  const names = (await readdir(folder)).sort();
  assert.equal(names.length, 2);
  assert.ok(names.includes('photo.jpg'));
  assert.ok(names.some(name => /^photo__[0-9a-f]{10}\.jpg$/.test(name)));
  assert.equal(await readFile(path.join(folder, 'photo.jpg'), 'utf8'), '123');
  assert.equal(await readFile(path.join(folder, names.find(x => x !== 'photo.jpg')!), 'utf8'), '123456789');
  const again = await run();
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, 2);
});

test('same name and size is ignored by default; SHA-256 detects different contents', async () => {
  const { first, second, destination, put, run, job } = await setup();
  await put(first, 'pic.jpg', 'ABC');
  await put(second, 'pic.jpg', 'DEF');
  const bySize = await run();
  assert.equal(bySize.copied, 1);
  assert.equal(bySize.skipped, 1);
  assert.deepEqual(await readdir(destination), ['pic.jpg']);
  job.compareMode = 'sha256';
  const byHash = await run();
  assert.equal(byHash.renamed, 1);
  assert.equal((await readdir(destination)).length, 2);
  const repeat = await run();
  assert.equal(repeat.copied, 0);
});

test('dry-run models conflicts across multiple sources without writing anything', async () => {
  const { first, second, destination, put, run } = await setup();
  await put(first, '2027/pic.jpg', '123');
  await put(second, '2027/pic.jpg', '1234');
  const simulation = await run(true);
  assert.equal(simulation.status, 'completed');
  assert.equal(simulation.copied, 2);
  assert.equal(simulation.renamed, 1);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('skip policy does not overwrite an existing file', async () => {
  const { first, second, destination, put, run, job } = await setup();
  await put(first, 'same.txt', 'FIRST');
  await put(second, 'same.txt', 'SECOND');
  job.conflictPolicy = 'skip';
  const progress = await run();
  assert.equal(progress.copied, 1);
  assert.equal(progress.skipped, 1);
  assert.equal(await readFile(path.join(destination, 'same.txt'), 'utf8'), 'FIRST');
});

test('symlink under destination cannot redirect writes outside allowed tree', async () => {
  const { first, targetRoot, destination, put, run } = await setup();
  const escaped = path.join(targetRoot, 'escaped');
  await mkdir(destination);
  await mkdir(escaped);
  await symlink(escaped, path.join(destination, '2026'));
  await put(first, '2026/a.txt', 'SHOULD NOT WRITE');
  const progress = await run();
  assert.equal(progress.status, 'completed_with_errors');
  assert.equal(progress.errors, 1);
  assert.deepEqual(await readdir(escaped), []);
});
