import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chooseWriteMode, writeModeInternals } from './write-mode.js';

test('direct and atomic options allow an explicit Synology mount override', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ns-write-mode-'));
  assert.equal(await chooseWriteMode(directory, 'direct'), 'direct');
  assert.equal(await chooseWriteMode(directory, 'atomic'), 'atomic');
  await assert.rejects(chooseWriteMode(directory, 'none'), /auto, direct ou atomic/);
});

test('mountinfo parser selects the longest actual matching mount', () => {
  const info = [
    '1 0 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
    '2 1 8:2 / /volumeUSB1 rw,relatime - exfat /dev/sdb1 rw',
    '3 2 8:3 / /volumeUSB1/other rw,relatime - ext4 /dev/sdc1 rw'
  ].join('\n');
  assert.equal(writeModeInternals.mountIsExfat('/volumeUSB1/usbshare/Photos', info), true);
  assert.equal(writeModeInternals.mountIsExfat('/volumeUSB1/other/test', info), false);
  assert.equal(writeModeInternals.mountIsExfat('/volumeUSB10/unrelated', info), false);
  assert.equal(writeModeInternals.mountIsExfat('/volume1/Photos', info), false);
});

test('FUSE exFAT mounts and escaped mount paths are recognized', () => {
  const info = '4 1 0:42 / /volumeUSB1/usbshare\\040one rw - fuse.exfat /dev/sdb1 rw';
  assert.equal(writeModeInternals.mountPath('/volumeUSB1/usbshare\\040one'), '/volumeUSB1/usbshare one');
  assert.equal(writeModeInternals.mountIsExfat('/volumeUSB1/usbshare one/Photos', info), true);
});
