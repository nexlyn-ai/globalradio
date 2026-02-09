import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const TTL_SECONDS = 60;         // ✅ fenêtre stable 60s
const HEARTBEAT_SECONDS = 20;   // ✅ le client “ping” toutes les 20s

export default async function handler(req, res) {
  // Autorise GET + POST (pratique selon tes tests)
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = Date.now();
    const TTL_MS = 60_000; // un visiteur est "online" si on l'a vu dans les 45 dernières secondes

    // sid = identifiant onglet/navigateur
    const sid =
      (req.query && req.query.sid) ||
      (req.body && req.body.sid) ||
      null;

    if (!sid) {
      // pas de sid => on renvoie juste le compteur (utile debug)
      const online = await redis.zcard("gr:online");
      return res.status(200).json({ online });
    }

    // 1) enregistre / refresh ce sid
    await redis.zadd("gr:online", { score: now, member: String(sid) });

    // 2) purge les sid trop vieux
    await redis.zremrangebyscore("gr:online", 0, now - TTL_MS);

    // 3) renvoie le nombre online
    const online = await redis.zcard("gr:online");
    return res.status(200).json({ online });
  } catch (e) {
    return res.status(500).json({ error: "presence_failed" });
  }
}
