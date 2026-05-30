import Redis from "ioredis";

let redisClient: Redis | null = null;

try {
  if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    redisClient.on("error", () => { redisClient = null; });
  }
} catch { redisClient = null; }

// Safe redis wrapper - never throws
export const redis = {
  get: async (key: string) => { try { return await redisClient?.get(key) ?? null; } catch { return null; } },
  set: async (key: string, val: string, ...args: any[]) => { try { return await (redisClient as any)?.set(key, val, ...args); } catch { return null; } },
  incr: async (key: string) => { try { return await redisClient?.incr(key) ?? 0; } catch { return 0; } },
  expire: async (key: string, ttl: number) => { try { return await redisClient?.expire(key, ttl); } catch { return null; } },
  hset: async (key: string, ...args: any[]) => { try { return await (redisClient as any)?.hset(key, ...args); } catch { return null; } },
  hgetall: async (key: string) => { try { return await redisClient?.hgetall(key) ?? {}; } catch { return {}; } },
  ping: async () => { try { return await redisClient?.ping() ?? "PONG"; } catch { return "PONG"; } },
};
