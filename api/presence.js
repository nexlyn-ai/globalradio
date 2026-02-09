import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const TTL_SECONDS = 60;                 // fenêtre stable 60s
const TTL_MS = TTL_SECONDS * 1000;      // conversion ms

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = Date.now();

    const sid =
      (req.query && req.query.sid) ||
      (req.body && req.body.sid) ||
      null;

    // pas de sid => juste le compteur
    if (!sid) {
      // Optionnel: purge aussi ici pour un compteur toujours “propre”
      await redis.zremrangebyscore("gr:online", 0, now - TTL_MS);
      const online = await redis.zcard("gr:online");
      return res.status(200).json({ online });
    }

    await redis.zadd("gr:online", { score: now, member: String(sid) });
    await redis.zremrangebyscore("gr:online", 0, now - TTL_MS);

    const online = await redis.zcard("gr:online");
    return res.status(200).json({ online });
  } catch (e) {
    return res.status(500).json({ error: "presence_failed" });
  }
}
