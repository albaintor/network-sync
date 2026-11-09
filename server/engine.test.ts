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

test('extension filter includes only matching files and preserves nested paths', async () => {
  const { first, destination, job, put, run } = await setup();
  job.extensions = ['jpg', 'heic', 'mp4'];
  await put(first, '2026/one.JPG', 'picture');
  await put(first, '2026/two.HEIC', 'heic');
  await put(first, '2026/three.Mp4', 'video');
  await put(first, '2026/four.pdf', 'document');
  await put(first, '2026/noext', 'excluded');
  const progress = await run();
  assert.equal(progress.status, 'completed');
  assert.equal(progress.filesTotal, 3);
  assert.equal(progress.copied, 3);
  assert.equal(progress.excluded, 2);
  assert.deepEqual((await readdir(path.join(destination, '2026'))).sort(), ['one.JPG', 'three.Mp4', 'two.HEIC']);
});

test('extension filter applies to dry runs without creating a destination', async () => {
  const { first, destination, job, put, run } = await setup();
  job.extensions = ['txt'];
  await put(first, 'keep.txt', 'hello');
  await put(first, 'ignore.mkv', 'video');
  const progress = await run(true);
  assert.equal(progress.filesTotal, 1);
  assert.equal(progress.copied, 1);
  assert.equal(progress.excluded, 1);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('existing jobs without an extension filter still sync all files', async () => {
  const { first, job, put, run } = await setup();
  delete job.extensions;
  await put(first, 'document.pdf', 'PDF');
  await put(first, 'movie.mkv', 'VIDEO');
  const progress = await run();
  assert.equal(progress.copied, 2);
  assert.equal(progress.excluded, 0);
});

test('a paused sync does not write and resumes from the pending file', async () => {
  const { first, roots, job, destination, put } = await setup();
  const { PauseGate } = await import('./pause.js');
  const gate = new PauseGate();
  await put(first, 'long.mov', 'video');
  const progress = newProgress(job, false);
  let paused = false;
  const promise = executeSync(job, progress, roots, new AbortController().signal, () => {
    if (progress.phase === 'copying' && !paused) { paused = true; gate.pause(); }
  }, gate);
  // The synchronous update fires before the first copy, so the pause gate
  // prevents output even if the job has no other files.
  for (let attempt = 0; attempt < 500 && !paused; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(paused, true, 'Timed out before entering the paused copying phase');
  assert.equal(gate.isPaused, true);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
  gate.resume();
  await promise;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.copied, 1);
  assert.equal(await readFile(path.join(destination, 'long.mov'), 'utf8'), 'video');
});

test('a paused sync can be cancelled without leaving copied files', async () => {
  const { first, roots, job, destination, put } = await setup();
  const { PauseGate } = await import('./pause.js');
  const gate = new PauseGate();
  const controller = new AbortController();
  await put(first, 'paused.avi', 'video');
  const progress = newProgress(job, false);
  let paused = false;
  const promise = executeSync(job, progress, roots, controller.signal, () => {
    if (progress.phase === 'copying' && !paused) { paused = true; gate.pause(); }
  }, gate);
  for (let attempt = 0; attempt < 500 && !paused; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(paused, true, 'Timed out before entering the paused copying phase');
  controller.abort();
  await promise;
  assert.equal(progress.status, 'cancelled');
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});


test('size filter excludes files below or equal to the configured threshold', async () => {
  const { first, destination, job, put, run } = await setup();
  job.sizeFilter = { operator: 'gt', megabytes: 1 };
  await put(first, 'small.txt', 'short');
  await put(first, 'exact.txt', 'x'.repeat(1024 * 1024));
  await put(first, 'large.txt', 'y'.repeat(1024 * 1024 + 1));
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.filesTotal, 1);
  assert.equal(result.excluded, 2);
  assert.deepEqual(await readdir(destination), ['large.txt']);
});

test('regex matches filename, not directory, and composes with other filters', async () => {
  const { first, destination, job, put, run } = await setup();
  job.extensions = ['jpg'];
  job.sizeFilter = { operator: 'lt', megabytes: 0.001 };
  job.filenameRegex = '^IMG_[0-9]{3}\\.jpg$';
  job.filenameRegexIgnoreCase = true;
  await put(first, 'an-unmatched-parent/IMG_001.JPG', 'A');
  await put(first, 'an-unmatched-parent/IMG_002.jpg', 'B');
  await put(first, 'an-unmatched-parent/document.pdf', 'C');
  await put(first, 'an-unmatched-parent/IMG_other.jpg', 'D');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 2);
  assert.equal(result.excluded, 2);
  assert.deepEqual((await readdir(path.join(destination, 'an-unmatched-parent'))).sort(), ['IMG_001.JPG', 'IMG_002.jpg']);
});

test('dry-run applies size + regex filters without writing files', async () => {
  const { first, destination, job, put, run } = await setup();
  job.filenameRegex = '^archive_[0-9]+\\.txt$';
  job.sizeFilter = { operator: 'gt', megabytes: 0 };
  await put(first, 'archive_123.txt', 'ok');
  await put(first, 'archive_old.txt', 'skipped');
  const result = await run(true);
  assert.equal(result.filesTotal, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.copied, 1);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('skips Synology @eaDir metadata and recycle folders even when syncing all extensions', async () => {
  const { first, destination, put, run } = await setup();
  await put(first, 'archive/holiday.mp4', 'real video');
  await put(first, 'archive/@eaDir/holiday.mp4@SynoEAStream', 'metadata');
  await put(first, 'archive/#recycle/deleted.mp4', 'deleted video');
  await put(first, 'archive/@eaDir/nested/thumbnail.jpg', 'metadata');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 1);
  assert.equal(result.filesTotal, 1);
  assert.deepEqual(await readdir(path.join(destination, 'archive')), ['holiday.mp4']);
});


test('flat copy puts files from nested sources directly in the destination', async () => {
  const { first, second, destination, job, put, run } = await setup();
  job.layout = 'flat';
  await put(first, '2025/photos/a.jpg', 'picture A');
  await put(second, '2026/photos/b.jpg', 'picture B');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 2);
  assert.deepEqual((await readdir(destination)).sort(), ['a.jpg', 'b.jpg']);
  assert.equal(await readFile(path.join(first, '2025/photos/a.jpg'), 'utf8'), 'picture A');
});

test('flat copy applies the existing rename conflict policy to equal basenames', async () => {
  const { first, second, destination, job, put, run } = await setup();
  job.layout = 'flat';
  job.compareMode = 'sha256';
  await put(first, '2025/shared.jpg', 'AAA');
  await put(second, '2026/shared.jpg', 'BBB');
  const result = await run();
  assert.equal(result.copied, 2);
  assert.equal(result.renamed, 1);
  assert.equal((await readdir(destination)).length, 2);
  assert.deepEqual((await readdir(destination)).filter(x => x.startsWith('shared__')).length, 1);
  assert.equal((await run()).copied, 0);
});

test('move preserves hierarchy by default and removes only moved files and empty subfolders', async () => {
  const { first, destination, job, put, run } = await setup();
  job.operation = 'move';
  job.extensions = ['jpg'];
  await put(first, 'year/month/photo.jpg', 'photo');
  await put(first, 'year/notes.txt', 'keep');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.moved, 1);
  assert.equal(result.copied, 1);
  assert.equal(result.excluded, 1);
  assert.equal(await readFile(path.join(destination, 'year/month/photo.jpg'), 'utf8'), 'photo');
  await assert.rejects(readFile(path.join(first, 'year/month/photo.jpg')), { code: 'ENOENT' });
  await assert.rejects(readdir(path.join(first, 'year/month')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(first, 'year/notes.txt'), 'utf8'), 'keep');
});

test('flat move detects same-size different files and safely renames both', async () => {
  const { first, second, destination, job, put, run } = await setup();
  job.operation = 'move';
  job.layout = 'flat';
  // Even though size-only comparison is configured, moving must compare hashes.
  job.compareMode = 'size';
  await put(first, '2025/same.mp4', 'ABCD');
  await put(second, '2026/same.mp4', 'WXYZ');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.moved, 2);
  assert.equal(result.copied, 2);
  assert.equal(result.renamed, 1);
  const names = (await readdir(destination)).sort();
  assert.equal(names.length, 2);
  assert.ok(names.includes('same.mp4'));
  assert.ok(names.some(name => /^same__[0-9a-f]{10}\.mp4$/.test(name)));
  assert.deepEqual(await readdir(first), []);
  assert.deepEqual(await readdir(second), []);
});

test('moving a verified duplicate removes the source without recopying', async () => {
  const { first, destination, job, put, run } = await setup();
  await put(first, 'existing.txt', 'EXACT');
  assert.equal((await run()).copied, 1);
  job.operation = 'move';
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.moved, 1);
  assert.equal(await readFile(path.join(destination, 'existing.txt'), 'utf8'), 'EXACT');
  await assert.rejects(readFile(path.join(first, 'existing.txt')), { code: 'ENOENT' });
});

test('skip conflict in move mode retains the different source, even when sizes match', async () => {
  const { first, second, destination, job, put, run } = await setup();
  job.operation = 'move';
  job.layout = 'flat';
  job.conflictPolicy = 'skip';
  await put(first, '2025/photo.jpg', 'AAA');
  await put(second, '2026/photo.jpg', 'BBB');
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.moved, 1);
  assert.equal(await readFile(path.join(destination, 'photo.jpg'), 'utf8'), 'AAA');
  assert.equal(await readFile(path.join(second, '2026/photo.jpg'), 'utf8'), 'BBB');
});

test('dry-run move with flattening leaves source and destination untouched', async () => {
  const { first, destination, job, put, run } = await setup();
  job.operation = 'move';
  job.layout = 'flat';
  await put(first, 'photos/photo.jpg', 'A');
  const result = await run(true);
  assert.equal(result.status, 'completed');
  assert.equal(result.copied, 1);
  assert.equal(result.moved, 1);
  assert.equal(await readFile(path.join(first, 'photos/photo.jpg'), 'utf8'), 'A');
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('cancelling a paused move does not delete its source', async () => {
  const { first, roots, job, destination, put } = await setup();
  const { PauseGate } = await import('./pause.js');
  job.operation = 'move';
  await put(first, 'movie.mkv', 'video');
  const gate = new PauseGate();
  const controller = new AbortController();
  const progress = newProgress(job, false);
  const promise = executeSync(job, progress, roots, controller.signal, () => {
    if (progress.phase === 'copying') gate.pause();
  }, gate);
  for (let i = 0; i < 500 && !gate.isPaused; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(gate.isPaused, true);
  controller.abort();
  await promise;
  assert.equal(progress.status, 'cancelled');
  assert.equal(await readFile(path.join(first, 'movie.mkv'), 'utf8'), 'video');
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('move rejects overlapping source paths before writing or removing anything', async () => {
  const { first, roots, job, destination, put, run } = await setup();
  job.operation = 'move';
  await put(first, 'nested/photo.jpg', 'photo');
  job.sources = [first, path.join(first, 'nested')];
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessages[0], /imbriqu/);
  assert.equal(await readFile(path.join(first, 'nested/photo.jpg'), 'utf8'), 'photo');
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});
