import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesExtensions, normalizeExtensions } from './extensions.js';

test('extension filters normalize case, leading dots, deduplicate, and match compound suffixes', () => {
  const allowed = normalizeExtensions(['.JPG', 'jpg', 'mp4', 'tar.gz']);
  assert.deepEqual(allowed, ['jpg', 'mp4', 'tar.gz']);
  assert.equal(matchesExtensions('PHOTO.JPG', allowed), true);
  assert.equal(matchesExtensions('archive.tar.GZ', allowed), true);
  assert.equal(matchesExtensions('clip.mov', allowed), false);
  assert.equal(matchesExtensions('no-extension', allowed), false);
  assert.equal(matchesExtensions('anything.bin', null), true);
  assert.equal(matchesExtensions('anything.bin', undefined), true);
});

test('extension validation rejects empty filters and malformed entries', () => {
  assert.throws(() => normalizeExtensions([]), /1 à 100 extensions/);
  assert.throws(() => normalizeExtensions(['../etc']), /Extension de fichier invalide/);
  assert.throws(() => normalizeExtensions(['*']), /Extension de fichier invalide/);
  assert.throws(() => normalizeExtensions([123]), /Extension de fichier invalide/);
});
