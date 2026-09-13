import assert from 'node:assert/strict';
import { percentile, summarize } from './metrics';

assert.equal(percentile([], 95), 0);
assert.equal(percentile([4], 95), 4);
assert.equal(percentile([1, 2, 3, 4], 50), 2);
assert.deepEqual(summarize([4, 1, 3, 2]), {
  count: 4,
  p50: 2,
  p95: 4,
  p99: 4,
  max: 4,
});

process.stdout.write('load-harness metrics tests passed\n');
