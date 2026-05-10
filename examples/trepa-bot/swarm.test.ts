/**
 * Pure-function unit tests for the outcome-band swarm math.
 * Run with:  node --experimental-strip-types --test swarm.test.ts
 *
 * These tests don't touch the network or the SDK. They verify the band
 * math published in https://docs.trepa.io/developers/swarms.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  bandPosition,
  buildBandPlan,
  DEFAULT_SWARM_CONFIG,
} from './swarm.ts';
import { forecast, type PriceSample } from './strategy.ts';

function flat(spot: number, n: number): PriceSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60_000, p: spot }));
}

function trending(start: number, drift: number, n: number): PriceSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60_000, p: start + i * drift }));
}

test('bandPosition: center bot of an odd-count swarm predicts the anchor unchanged', () => {
  const anchor = 80_000;
  const count = 5;
  const center = (count - 1) / 2; // = 2 for count=5
  assert.equal(bandPosition(anchor, center, count, 100), anchor);
});

test('bandPosition: count=1 always returns the anchor', () => {
  assert.equal(bandPosition(80_000, 0, 1, 100), 80_000);
  assert.equal(bandPosition(80_000, 0, 1, 0), 80_000);
});

test('bandPosition: edge bots are exactly ±((count-1)/2)*spacing from anchor', () => {
  const anchor = 80_000;
  const spacing = 25;
  const count = 5; // edge offset = 2 * spacing = 50
  assert.equal(bandPosition(anchor, 0, count, spacing), anchor - 2 * spacing);
  assert.equal(bandPosition(anchor, count - 1, count, spacing), anchor + 2 * spacing);
});

test('bandPosition: bots are symmetric around the anchor', () => {
  const anchor = 80_000;
  const spacing = 17.5;
  const count = 7;
  for (let i = 0; i < count; i++) {
    const mirror = count - 1 - i;
    const a = bandPosition(anchor, i, count, spacing) - anchor;
    const b = bandPosition(anchor, mirror, count, spacing) - anchor;
    // a and b should be exact opposites; allow tiny float slack.
    assert.ok(Math.abs(a + b) < 1e-9, `i=${i} mirror=${mirror}: ${a} vs ${b}`);
  }
});

test('bandPosition: even-count swarm has no exact center; pair around anchor is ±spacing/2', () => {
  const anchor = 80_000;
  const spacing = 40;
  const count = 4; // mid offsets are ±0.5 * spacing
  assert.equal(bandPosition(anchor, 1, count, spacing), anchor - 0.5 * spacing);
  assert.equal(bandPosition(anchor, 2, count, spacing), anchor + 0.5 * spacing);
});

test('bandPosition: rejects bad inputs', () => {
  assert.throws(() => bandPosition(Number.NaN, 0, 3, 10), /anchor not finite/);
  assert.throws(() => bandPosition(80_000, -1, 3, 10), /index .* out of range/);
  assert.throws(() => bandPosition(80_000, 3, 3, 10), /index .* out of range/);
  assert.throws(() => bandPosition(80_000, 0, 0, 10), /count must be a positive integer/);
  assert.throws(() => bandPosition(80_000, 0, 1.5, 10), /count must be a positive integer/);
  assert.throws(() => bandPosition(80_000, 0, 3, -1), /spacing must be finite and non-negative/);
});

test('buildBandPlan: spacing scales linearly with typicalMoveDollars (i.e. with σ)', () => {
  // Two trending tapes with different drifts but the same σ would have
  // the same typicalMoveDollars; instead we vary the *amount* of price
  // movement so σ differs and check spacing scales accordingly.
  const calmSamples = trending(80_000, 1, 60);   // tiny moves
  const noisySamples = trending(80_000, 50, 60); // bigger moves → bigger σ
  const calmF = forecast(80_000, calmSamples);
  const noisyF = forecast(80_000, noisySamples);

  assert.ok(noisyF.typicalMoveDollars > calmF.typicalMoveDollars, 'sanity: noisy tape has larger typical move');

  const calmPlan = buildBandPlan(calmF, { ...DEFAULT_SWARM_CONFIG, count: 5 });
  const noisyPlan = buildBandPlan(noisyF, { ...DEFAULT_SWARM_CONFIG, count: 5 });

  // spacing must be > 0 in both cases (σ > 0 in both) and strictly larger in the noisier tape.
  assert.ok(calmPlan.spacing > 0, 'calm spacing should be positive');
  assert.ok(noisyPlan.spacing > calmPlan.spacing, `noisy spacing ${noisyPlan.spacing} should exceed calm ${calmPlan.spacing}`);

  // ratio of spacings equals ratio of typicalMoveDollars (same fraction applied).
  const spacingRatio = noisyPlan.spacing / calmPlan.spacing;
  const moveRatio = noisyF.typicalMoveDollars / calmF.typicalMoveDollars;
  assert.ok(Math.abs(spacingRatio - moveRatio) < 1e-9, `ratios: spacing ${spacingRatio} vs move ${moveRatio}`);
});

test('buildBandPlan: predictions are sorted ascending and centered on the anchor', () => {
  const samples = trending(80_000, 50, 60);
  const f = forecast(80_000, samples);
  const plan = buildBandPlan(f, { ...DEFAULT_SWARM_CONFIG, count: 5 });

  // Centered on anchor: mean of predictions equals anchor for symmetric arrangement.
  const mean = plan.predictions.reduce((a, b) => a + b, 0) / plan.predictions.length;
  assert.ok(Math.abs(mean - plan.anchor) < 1e-9, `mean ${mean} vs anchor ${plan.anchor}`);

  // Strictly ascending (spacing > 0 in a trending tape).
  for (let i = 1; i < plan.predictions.length; i++) {
    assert.ok(
      plan.predictions[i]! > plan.predictions[i - 1]!,
      `predictions not ascending at i=${i}: ${plan.predictions[i - 1]} -> ${plan.predictions[i]}`,
    );
  }
});

test('buildBandPlan: flat tape → typical move is 0, all bots predict the anchor', () => {
  const samples = flat(80_000, 60);
  const f = forecast(80_000, samples);
  assert.equal(f.typicalMoveDollars, 0);
  const plan = buildBandPlan(f, { ...DEFAULT_SWARM_CONFIG, count: 5 });
  assert.equal(plan.spacing, 0);
  for (const v of plan.predictions) assert.equal(v, plan.anchor);
});
