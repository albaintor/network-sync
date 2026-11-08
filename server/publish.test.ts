import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, link, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishWithoutOverwrite } from './publish.js';

test('hard-link publication is preferred on filesystems that support it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ns-publish-'));
  const temp = path.join(root, '.tmp');
  const dest = path.join(root, 'movie.mkv');
  await writeFile(temp, 'content');
  assert.equal(await publishWithoutOverwrite(temp, dest), 'linked');
  assert.equal(await readFile(dest, 'utf8'), 'content');
  // The temporary hard link may be removed after publishing the target.
  assert.deepEqual((await readdir(root)).sort(), ['.tmp', 'movie.mkv']);
});

test('EPERM on hard links falls back to exclusive copy without clobbering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ns-publish-'));
  const temp = path.join(root, '.tmp');
  const dest = path.join(root, 'clip.mp4');
  await writeFile(temp, 'copied');
  const failLink: typeof link = async () => {
    throw Object.assign(new Error('Hardlinks unsupported'), { code: 'EPERM' });
  };
  const exclusive: typeof copyFile = async (src, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL);
    await copyFile(src, target, flags);
  };
  assert.equal(await publishWithoutOverwrite(temp, dest, failLink, exclusive), 'copied');
  assert.equal(await readFile(dest, 'utf8'), 'copied');
  await assert.rejects(publishWithoutOverwrite(temp, dest, failLink, exclusive), { code: 'EEXIST' });
  assert.equal(await readFile(dest, 'utf8'), 'copied');
});

test('EEXIST on the hard-link fast path is not masked by fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ns-publish-'));
  const temp = path.join(root, '.tmp');
  const dest = path.join(root, 'existing.jpg');
  await writeFile(temp, 'new');
  await writeFile(dest, 'original');
  await assert.rejects(publishWithoutOverwrite(temp, dest), { code: 'EEXIST' });
  assert.equal(await readFile(dest, 'utf8'), 'original');
});

test('EACCES from hard-link publication is not masked by a copy attempt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ns-publish-'));
  const temp = path.join(root, '.tmp');
  const dest = path.join(root, 'movie.mp4');
  await writeFile(temp, 'new');
  const failLink: typeof link = async () => {
    throw Object.assign(new Error('Denied'), { code: 'EACCES' });
  };
  let called = false;
  const spy: typeof copyFile = async () => { called = true; };
  await assert.rejects(publishWithoutOverwrite(temp, dest, failLink, spy), { code: 'EACCES' });
  assert.equal(called, false);
});
