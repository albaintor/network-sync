import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PauseGate } from './pause.js';

test('pause blocks until resumed and then permits progress', async () => {
  const gate = new PauseGate();
  const controller = new AbortController();
  gate.pause();
  let entered = false;
  const waiting = gate.wait(controller.signal).then(() => { entered = true; });
  await Promise.resolve();
  assert.equal(entered, false);
  gate.resume();
  await waiting;
  assert.equal(entered, true);
  assert.equal(gate.isPaused, false);
});

test('cancel a paused run without requiring resume', async () => {
  const gate = new PauseGate();
  const controller = new AbortController();
  gate.pause();
  const pending = gate.wait(controller.signal);
  controller.abort();
  await assert.rejects(pending, /annulée/);
});
