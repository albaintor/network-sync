import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteDuplicates, scanDuplicates } from './duplicates.js';
import { newProgress } from './engine.js';
import type { Roots, SyncJob } from './models.js';

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'network-sync-duplicates-'));
  const folder = path.join(home, 'photos');
  const other = path.join(home, 'outside');
  await Promise.all([mkdir(folder), mkdir(other)]);
  const roots: Roots = { sources: [folder], destinations: [other] };
  const job: SyncJob = {
    id: 'a6ea2615-5b08-4a70-90bf-bb93e0865b02',
    name: 'Doublons photos', operation: 'duplicates', sources: [folder], destination: '',
    conflictPolicy: 'rename', compareMode: 'size', cron: null, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const put = async (relative: string, content: string) => {
    const filename = path.join(folder, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
    return filename;
  };
  const scan = () => {
    const progress = newProgress(job, true);
    return scanDuplicates(job, progress, roots, new AbortController().signal)
      .then(result => ({ result, progress }));
  };
  return { folder, other, roots, job, put, scan };
}

test('identical contents with different names and subfolders form one group, not merely equal sizes', async () => {
  const { put, scan } = await setup();
  const first = await put('2019/original.jpg', 'ABCDEF');
  const second = await put('2024/new-name.png', 'ABCDEF');
  await put('2022/different.jpg', 'FEDCBA'); // equal size, different digest
  await put('small.txt', 'x');
  const { result, progress } = await scan();
  assert.equal(progress.status, 'completed');
  assert.equal(progress.filesTotal, 4);
  assert.equal(progress.candidateFiles, 3);
  assert.equal(progress.duplicateGroups, 1);
  assert.ok(result);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].files.map(x => x.path).sort(), [first, second].sort());
  assert.match(result.groups[0].sha256, /^[a-f0-9]{64}$/);
});

test('same-size files with different data do not count as duplicates', async () => {
  const { put, scan } = await setup();
  await put('one.mkv', '1234');
  await put('two.mkv', '5678');
  const { result, progress } = await scan();
  assert.equal(progress.status, 'completed');
  assert.deepEqual(result?.groups, []);
});

test('scan ignores symlinks, Synology metadata and recycle folder', async () => {
  const { folder, other, put, scan } = await setup();
  await put('a.mp4', 'dup');
  await put('nested/b.mp4', 'dup');
  await put('@eaDir/metadata.mp4', 'dup');
  await put('#recycle/trashed.mp4', 'dup');
  await writeFile(path.join(other, 'external.mp4'), 'dup');
  await symlink(path.join(other, 'external.mp4'), path.join(folder, 'linked.mp4'));
  const { result, progress } = await scan();
  assert.equal(progress.filesTotal, 2);
  assert.equal(result?.groups.length, 1);
  assert.equal(result?.groups[0].files.length, 2);
});

test('deletion keeps the explicitly selected file and removes other verified copies', async () => {
  const { folder, roots, put, scan } = await setup();
  const a = await put('a.jpg', 'SAME');
  const b = await put('nested/b.jpg', 'SAME');
  const c = await put('nested/c.jpg', 'SAME');
  const unrelated = await put('notes.txt', 'different');
  const { result } = await scan();
  assert.ok(result);
  assert.equal(result.groups[0].files.length, 3);
  const report = await deleteDuplicates(result, [{ groupId: result.groups[0].id, keep: b }], roots);
  assert.deepEqual(report.errors, []);
  assert.equal(report.deleted, 2);
  assert.equal(report.freedBytes, 8);
  assert.equal(await readFile(b, 'utf8'), 'SAME');
  assert.equal(await readFile(unrelated, 'utf8'), 'different');
  await assert.rejects(readFile(a, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(c, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual((await readdir(folder)).sort(), ['nested', 'notes.txt']);
});

test('deletion rejects unknown keepers and duplicate group selections without removing anything', async () => {
  const { roots, put, scan } = await setup();
  const a = await put('a.bin', 'ABCD');
  const b = await put('b.bin', 'ABCD');
  const { result } = await scan();
  assert.ok(result);
  const groupId = result.groups[0].id;
  await assert.rejects(deleteDuplicates(result, [{ groupId, keep: '/tmp/arbitrary-file' }], roots), /inconnu/);
  await assert.rejects(deleteDuplicates(result, [
    { groupId, keep: a }, { groupId, keep: b }
  ], roots), /invalide|répétée/);
  assert.equal(await readFile(a, 'utf8'), 'ABCD');
  assert.equal(await readFile(b, 'utf8'), 'ABCD');
});

test('modified candidate or keeper prevents deletion of the whole group', async () => {
  const { roots, put, scan } = await setup();
  const a = await put('a.mkv', 'DATA');
  const b = await put('b.mkv', 'DATA');
  const { result } = await scan();
  assert.ok(result);
  await writeFile(b, 'EDITED');
  const report = await deleteDuplicates(result, [{ groupId: result.groups[0].id, keep: a }], roots);
  assert.equal(report.deleted, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(await readFile(a, 'utf8'), 'DATA');
  assert.equal(await readFile(b, 'utf8'), 'EDITED');
});

test('hard links do not count as reclaimable duplicates', async () => {
  const { folder, put, scan } = await setup();
  const original = await put('source.txt', 'SHARED');
  await link(original, path.join(folder, 'alias.txt'));
  const { result, progress } = await scan();
  assert.equal(progress.status, 'completed');
  assert.equal(result?.groups.length, 0);
});

test('scan cannot reach outside the mounted source directory', async () => {
  const { folder, other, job, roots, put } = await setup();
  await put('safe.txt', 'safe');
  job.sources = [other];
  const progress = newProgress(job, true);
  const result = await scanDuplicates(job, progress, roots, new AbortController().signal);
  assert.equal(result, null);
  assert.equal(progress.status, 'failed');
  assert.equal(await readFile(path.join(folder, 'safe.txt'), 'utf8'), 'safe');
});

test('aborted scan preserves all files and produces no actionable results', async () => {
  const { folder, roots, job, put } = await setup();
  await put('a.jpg', '123');
  await put('b.jpg', '123');
  const controller = new AbortController();
  controller.abort();
  const progress = newProgress(job, true);
  const result = await scanDuplicates(job, progress, roots, controller.signal);
  assert.equal(result, null);
  assert.equal(progress.status, 'cancelled');
  assert.deepEqual((await readdir(folder)).sort(), ['a.jpg', 'b.jpg']);
});
