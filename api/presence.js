import { Redis } from "@upstash/redis";

// Redis gratuit (via Vercel Storage)
const redis = Redis.fromEnv();

// Un visiteur est "en ligne" s’il a ping dans les 30 dernières secondes
const TTL_SECONDS = 30;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const id = (body?.id || "").toString().slice(0, 120);
    if (!id) {
      res.status(400).json({ error: "Missing id" });
      return;
    }

    const key = `presence:${id}`;

    // 1) marque ce visiteur comme actif (expire automatiquement)
    await redis.set(key, "1", { ex: TTL_SECONDS });

    // 2) compte les visiteurs actifs
    let cursor = 0;
    let count = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: "presence:*",
        count: 500
      });
      cursor = Number(nextCursor);
      count += (keys?.length || 0);
    } while (cursor !== 0);

    res.status(200).json({ online: count });
  } catch (e) {
    res.status(200).json({ online: null });
  }
}
