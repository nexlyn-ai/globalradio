import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Fenêtre "online" : si on a vu le visiteur dans les 40 dernières secondes -> online
const ONLINE_WINDOW_SEC = 40;
// TTL des clés visiteurs (un peu plus large que la fenêtre)
const TTL_SEC = 120;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const visitorId = String(req.query.id || "").trim();

    // 1) Si on a un id, on enregistre la présence
    if (visitorId) {
      const key = `gr:presence:${visitorId}`;
      const now = Date.now();
      // set + ttl
      await redis.set(key, now, { ex: TTL_SEC });
    }

    // 2) Compter les visiteurs actifs
    // Upstash supporte SCAN (via sdk) -> on récupère les clés presence
    let cursor = 0;
    let online = 0;
    const cutoff = Date.now() - ONLINE_WINDOW_SEC * 1000;

    do {
      // scan par lots
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: "gr:presence:*",
        count: 200,
      });

      cursor = Number(nextCursor) || 0;

      if (keys && keys.length) {
        // mget pour limiter les requêtes
        const values = await redis.mget(...keys);

        for (const v of values) {
          const ts = Number(v || 0);
          if (ts && ts >= cutoff) online++;
        }
      }
    } while (cursor !== 0);

    // (optionnel) on peut mettre un cache court, mais là on reste simple
    res.status(200).json({ online });
  } catch (e) {
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
}
