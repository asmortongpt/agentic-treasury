/**
 * Pure-function unit tests for the Trepa forecast strategy.
 * Run with:  node --experimental-strip-types --test strategy.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { forecast, DEFAULT_CONFIG, type PriceSample } from './strategy.ts';

function flat(spot: number, n: number): PriceSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60_000, p: spot }));
}

function trending(start: number, drift: number, n: number): PriceSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60_000, p: start + i * drift }));
}

test('flat tape → prediction equals spot', () => {
  const samples = flat(80_000, 60);
  const f = forecast(80_000, samples);
  assert.equal(f.prediction, 80_000);
  assert.equal(f.cappedNudge, 0);
});

test('insufficient samples → prediction equals spot', () => {
  const f = forecast(80_000, [{ t: 0, p: 80_000 }]);
  assert.equal(f.prediction, 80_000);
});

test('upward trend → positive nudge, capped', () => {
  const samples = trending(80_000, 50, 60); // +$50/minute drift
  const f = forecast(80_000, samples);
  assert.ok(f.cappedNudge > 0, `expected positive nudge, got ${f.cappedNudge}`);
  assert.ok(f.cappedNudge <= f.capDollars + 1e-6, `nudge ${f.cappedNudge} exceeded cap ${f.capDollars}`);
});

test('downward trend → negative nudge, capped', () => {
  const samples = trending(80_000, -30, 60);
  const f = forecast(80_000, samples);
  assert.ok(f.cappedNudge < 0);
  assert.ok(Math.abs(f.cappedNudge) <= f.capDollars + 1e-6);
});

test('cap binds when raw drift exceeds typical move fraction', () => {
  const samples = trending(80_000, 200, 60); // big drift
  const f = forecast(80_000, samples);
  assert.equal(Math.abs(f.cappedNudge), f.capDollars, 'cap should bind exactly');
});

test('config respected: driftCapFraction=1.0 allows larger nudge', () => {
  const samples = trending(80_000, 100, 60);
  const tight = forecast(80_000, samples, { ...DEFAULT_CONFIG, driftCapFraction: 0.1 });
  const loose = forecast(80_000, samples, { ...DEFAULT_CONFIG, driftCapFraction: 1.0 });
  assert.ok(loose.capDollars > tight.capDollars);
});
