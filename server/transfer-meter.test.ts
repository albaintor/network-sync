import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newProgress } from './engine.js';
import { TransferMeter } from './transfer-meter.js';
import type { SyncJob } from './models.js';

function setup() {
  const job: SyncJob = {
    id: 'afe9f826-0fe8-42cb-a6fa-0f986aa28399', name: 'Test',
    sources: ['/tmp/a'], destination: '/tmp/b', operation: 'copy',
    conflictPolicy: 'rename', compareMode: 'size', cron: null, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const progress = newProgress(job, false);
  let clock = 0;
  progress.bytesTotal = 4_000_000;
  const meter = new TransferMeter(progress, () => {}, () => clock);
  return { progress, meter, tick: (ms: number) => { clock += ms; } };
}

test('live speed and ETA are derived from bytes streamed during a large file', () => {
  const { progress, meter, tick } = setup();
  meter.begin();
  assert.equal(progress.bytesToTransfer, 4_000_000);
  assert.equal(progress.transferSpeedBytesPerSec, null);
  meter.beginFile(2_000_000);
  meter.chunk(500_000);
  assert.equal(progress.bytesTransferred, 500_000);
  assert.equal(progress.transferEtaSeconds, null, 'no ETA until an observed interval');
  tick(1_000);
  meter.chunk(500_000);
  assert.equal(progress.bytesTransferred, 1_000_000);
  assert.equal(progress.currentFileBytes, 1_000_000);
  assert.equal(progress.transferSpeedBytesPerSec, 1_000_000);
  assert.equal(progress.transferEtaSeconds, 3);

  progress.bytesCopied += 2_000_000;
  meter.completeFile();
  assert.equal(progress.bytesTransferred, 2_000_000);
  assert.equal(progress.transferEtaSeconds, 2);
});

test('skipped files reduce total predicted bytes and remaining time', () => {
  const { progress, meter, tick } = setup();
  meter.begin();
  meter.beginFile(1_000_000);
  meter.chunk(500_000);
  tick(1_000);
  meter.chunk(500_000);
  progress.bytesCopied += 1_000_000;
  meter.completeFile();
  meter.skip(2_000_000);
  assert.equal(progress.bytesToTransfer, 2_000_000);
  assert.equal(progress.bytesTransferred, 1_000_000);
  assert.equal(progress.transferEtaSeconds, 1);
  meter.skip(1_000_000);
  assert.equal(progress.transferEtaSeconds, 0);
  meter.finish();
  assert.equal(progress.transferEtaSeconds, null);
});

test('partial failed copy is removed from committed progress and anticipated bytes', () => {
  const { progress, meter, tick } = setup();
  meter.begin();
  meter.beginFile(2_000_000);
  meter.chunk(800_000);
  tick(1_000);
  meter.chunk(200_000);
  meter.fail(2_000_000);
  assert.equal(progress.bytesTransferred, 0);
  assert.equal(progress.bytesToTransfer, 2_000_000);
  assert.equal(progress.currentFileBytes, 0);
  assert.equal(progress.currentFileSize, null);
});

test('stale rate resets after long pauses rather than producing an invalid ETA', () => {
  const { progress, meter, tick } = setup();
  meter.begin();
  meter.beginFile(3_000_000);
  meter.chunk(500_000);
  tick(1_000);
  meter.chunk(500_000);
  assert.ok((progress.transferSpeedBytesPerSec ?? 0) > 0);
  tick(15_000);
  meter.chunk(100_000);
  assert.equal(progress.transferSpeedBytesPerSec, null);
  assert.equal(progress.transferEtaSeconds, null);
});
