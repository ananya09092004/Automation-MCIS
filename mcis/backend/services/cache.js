let redis = null;

// Redis sirf local mein use karo
// Production mein disable — Render pe Redis nahi hai
if (process.env.NODE_ENV !== 'production') {
  try {
    const Redis = require('ioredis');
    redis = new Redis({ host: 'localhost', port: 6379, lazyConnect: true });
    redis.connect().catch(() => {
      console.log('Redis not available — caching disabled');
      redis = null;
    });
  } catch {
    redis = null;
  }
}

async function getCache(key) {
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

async function setCache(key, value, ttl = 3600) {
  if (!redis) return;
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
  } catch {}
}

module.exports = { getCache, setCache };