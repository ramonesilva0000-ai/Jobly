// Lightweight token-bucket + per-key throttle. No external deps.
//
// Two helpers:
//  - createTokenBucket({ ratePerInterval, intervalMs }) — global bucket
//  - createPerKeyThrottle({ minIntervalMs }) — ensures ≥ N ms between calls per key

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTokenBucket({ ratePerInterval, intervalMs }) {
  if (!ratePerInterval || !intervalMs) {
    throw new Error('createTokenBucket requires ratePerInterval and intervalMs');
  }
  const capacity = ratePerInterval;
  let tokens = capacity;
  let lastRefill = Date.now();

  function refill() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed <= 0) return;
    const refillRate = capacity / intervalMs;
    tokens = Math.min(capacity, tokens + elapsed * refillRate);
    lastRefill = now;
  }

  return {
    async take(n = 1) {
      while (true) {
        refill();
        if (tokens >= n) {
          tokens -= n;
          return;
        }
        const deficit = n - tokens;
        const waitMs = Math.ceil((deficit * intervalMs) / capacity) + 5;
        await sleep(waitMs);
      }
    },
  };
}

function createPerKeyThrottle({ minIntervalMs }) {
  const lastByKey = new Map();
  return {
    async wait(key) {
      const now = Date.now();
      const last = lastByKey.get(key) || 0;
      const elapsed = now - last;
      if (elapsed < minIntervalMs) {
        await sleep(minIntervalMs - elapsed);
      }
      lastByKey.set(key, Date.now());
    },
  };
}

module.exports = { createTokenBucket, createPerKeyThrottle, sleep };
