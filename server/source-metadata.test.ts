import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedSourceMetadata, sourceMetadataMatches } from './source-metadata.js';

test('exFAT: inode changes alone are not source modifications', () => {
  const scanned = { size: 12_345, mtimeMs: 1_730_000_000_000, dev: 54, ino: 4001 };
  const reopened = { ...scanned, ino: 9800332 };
  assert.equal(sourceMetadataMatches(scanned, reopened), true);
  assert.deepEqual(changedSourceMetadata(scanned, reopened), []);
});

test('changed size, modification time or volume still reject source', () => {
  const scanned = { size: 12_345, mtimeMs: 1_730_000_000_000, dev: 54, ino: 4001 };
  for (const altered of [
    { ...scanned, size: scanned.size + 1 },
    { ...scanned, mtimeMs: scanned.mtimeMs + 2000 },
    { ...scanned, dev: scanned.dev + 1 }
  ]) {
    assert.equal(sourceMetadataMatches(scanned, altered), false);
    assert.ok(changedSourceMetadata(scanned, altered).length);
  }
});

test('metadata change diagnostics identify only the fields that differ', () => {
  const expected = { size: 1000, mtimeMs: 10_000, dev: 4 };
  const actual = { size: 995, mtimeMs: 11_000, dev: 4 };
  assert.deepEqual(changedSourceMetadata(expected, actual), ['taille', 'date de modification']);
});
