import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isAppleLivePhotoVideo } from './live-photo.js';

function box(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, data]);
}

function largeBox(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(data.length + 16), 8);
  return Buffer.concat([header, data]);
}

async function fixture(name: string, data: Buffer): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ns-live-photo-'));
  const filename = path.join(root, name);
  await writeFile(filename, data);
  return filename;
}

test('detects Apple Live Photo via content identifier in moov on MOV and MP4', async () => {
  const movie = Buffer.concat([
    box('ftyp', Buffer.from('qt  ', 'ascii')),
    box('mdat', Buffer.from('real video bytes')),
    box('moov', box('keys', Buffer.from('com.apple.quicktime.content.identifier', 'utf8')))
  ]);
  const mov = await fixture('IMG_0001.MOV', movie);
  const mp4 = await fixture('IMG_0002.mp4', movie);
  assert.equal(await isAppleLivePhotoVideo(mov), true);
  assert.equal(await isAppleLivePhotoVideo(mp4), true);
});

test('recognizes the still-image-time marker when content identifier is absent', async () => {
  const movie = box('moov', box('keys', Buffer.from('com.apple.quicktime.still-image-time')));
  const filename = await fixture('photo.m4v', movie);
  assert.equal(await isAppleLivePhotoVideo(filename), true);
});

test('does not mistake regular short MOV for Live Photo', async () => {
  const movie = Buffer.concat([
    box('ftyp', Buffer.from('qt  ')),
    box('moov', box('keys', Buffer.from('com.apple.quicktime.creationdate'))),
    box('mdat', Buffer.from('short'))
  ]);
  const filename = await fixture('short-video.mov', movie);
  assert.equal(await isAppleLivePhotoVideo(filename), false);
});

test('marker inside video payload (mdat) does not produce false positive', async () => {
  const movie = Buffer.concat([
    box('mdat', Buffer.from('com.apple.quicktime.content.identifier')),
    box('moov', box('keys', Buffer.from('com.apple.quicktime.creationdate')))
  ]);
  const filename = await fixture('non-live.mov', movie);
  assert.equal(await isAppleLivePhotoVideo(filename), false);
});

test('matches markers across metadata read-buffer boundaries', async () => {
  const data = Buffer.concat([
    Buffer.alloc(256 * 1024 - 20, 0x2e),
    Buffer.from('com.apple.quicktime.content.identifier')
  ]);
  const filename = await fixture('boundary.mov', box('moov', data));
  assert.equal(await isAppleLivePhotoVideo(filename), true);
});

test('handles extended 64-bit atom sizes and moov after mdat', async () => {
  const movie = Buffer.concat([
    largeBox('mdat', Buffer.from('video stream')),
    largeBox('moov', Buffer.from('com.apple.quicktime.content.identifier'))
  ]);
  const filename = await fixture('extended.mov', movie);
  assert.equal(await isAppleLivePhotoVideo(filename), true);
});

test('unknown extensions, malformed atoms and absent metadata are treated as ordinary files', async () => {
  const movie = box('moov', Buffer.from('com.apple.quicktime.content.identifier'));
  assert.equal(await isAppleLivePhotoVideo(await fixture('image.HEIC', movie)), false);
  assert.equal(await isAppleLivePhotoVideo(await fixture('video.avi', movie)), false);
  const invalid = Buffer.alloc(8);
  invalid.writeUInt32BE(5, 0);
  invalid.write('moov', 4, 'latin1');
  assert.equal(await isAppleLivePhotoVideo(await fixture('invalid.mov', invalid)), false);
  assert.equal(await isAppleLivePhotoVideo(await fixture('empty.mov', Buffer.alloc(0))), false);
});

test('aborted metadata inspection cancels without changing the source', async () => {
  const movie = box('moov', Buffer.from('com.apple.quicktime.content.identifier'));
  const filename = await fixture('still.mov', movie);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(isAppleLivePhotoVideo(filename, controller.signal), /annulée/);
  assert.deepEqual(await readFile(filename), movie);
});
