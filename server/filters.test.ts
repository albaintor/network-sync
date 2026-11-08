import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BYTES_PER_MO, compileFilenameRegex, matchesFileFilters,
  normalizeFilenameRegex, normalizeFilenameRegexIgnoreCase, normalizeSizeFilter
} from './filters.js';

const empty = { extensions: null, sizeFilter: null };

test('size filters use strict limits in binary megabytes', () => {
  const gt = normalizeSizeFilter({ operator: 'gt', megabytes: 5 });
  const lt = normalizeSizeFilter({ operator: 'lt', megabytes: 5 });
  assert.deepEqual(gt, { operator: 'gt', megabytes: 5 });
  assert.equal(matchesFileFilters('a.mov', 5 * BYTES_PER_MO + 1, { ...empty, sizeFilter: gt }, null), true);
  assert.equal(matchesFileFilters('a.mov', 5 * BYTES_PER_MO, { ...empty, sizeFilter: gt }, null), false);
  assert.equal(matchesFileFilters('a.mov', 5 * BYTES_PER_MO - 1, { ...empty, sizeFilter: lt }, null), true);
  assert.equal(matchesFileFilters('a.mov', 5 * BYTES_PER_MO, { ...empty, sizeFilter: lt }, null), false);
  assert.equal(matchesFileFilters('a.mov', 5 * BYTES_PER_MO + 1, { ...empty, sizeFilter: lt }, null), false);
  assert.equal(matchesFileFilters('a.mov', 0, { ...empty, sizeFilter: { operator: 'gt', megabytes: 0 } }, null), false);
  assert.equal(matchesFileFilters('a.mov', 20, empty, null), true);
});

test('invalid size filter parameters are rejected', () => {
  for (const bad of ['5', 5, { operator: 'gte', megabytes: 5 },
    { operator: 'gt', megabytes: -1 }, { operator: 'gt', megabytes: Infinity },
    { operator: 'lt', megabytes: NaN }, { operator: 'lt', megabytes: '10' }]) {
    assert.throws(() => normalizeSizeFilter(bad));
  }
  assert.equal(normalizeSizeFilter(null), null);
});

test('regex applies to basename, supports literal groups and ignore-case', () => {
  const pattern = normalizeFilenameRegex('^IMG_[0-9]{4}\\.(jpg|png)$');
  assert.equal(pattern, '^IMG_[0-9]{4}\\.(jpg|png)$');
  assert.equal(compileFilenameRegex(pattern)!.test('IMG_1234.jpg'), true);
  assert.equal(compileFilenameRegex(pattern)!.test('prefix_IMG_1234.jpg'), false);
  assert.equal(compileFilenameRegex(pattern)!.test('img_1234.jpg'), false);
  assert.equal(compileFilenameRegex(pattern, true)!.test('img_1234.jpg'), true);
  assert.equal(normalizeFilenameRegexIgnoreCase(true), true);
  assert.equal(normalizeFilenameRegexIgnoreCase(undefined), false);
});

test('regex guard rejects invalid and potentially exponential patterns', () => {
  for (const bad of ['[', '(', 'a{1001}', '(a+)+$', '(a|aa)+$', '(?=a)a', '^(.)\\1$']) {
    assert.throws(() => normalizeFilenameRegex(bad), bad);
  }
  assert.throws(() => normalizeFilenameRegex('a'.repeat(201)));
  assert.throws(() => normalizeFilenameRegexIgnoreCase('yes'));
  assert.equal(normalizeFilenameRegex('   '), null);
});

test('extension, size and regex filters are cumulative', () => {
  const job = { extensions: ['jpg'], sizeFilter: { operator: 'gt' as const, megabytes: 2 } };
  const regex = compileFilenameRegex('^IMG_\\d+\\.jpg$', true);
  assert.equal(matchesFileFilters('IMG_002.JPG', 3 * BYTES_PER_MO, job, regex), true);
  assert.equal(matchesFileFilters('IMG_002.PNG', 3 * BYTES_PER_MO, job, regex), false);
  assert.equal(matchesFileFilters('IMG_002.JPG', BYTES_PER_MO, job, regex), false);
  assert.equal(matchesFileFilters('holiday.JPG', 3 * BYTES_PER_MO, job, regex), false);
});
