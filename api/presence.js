import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // ✅ Autorise GET (navigateur) + POST (si tu veux plus tard)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Pour l’instant on renvoie une valeur test (0) si rien en base
    const online = (await redis.get("gr:online")) ?? 0;

    return res.status(200).json({ online: Number(online) });
  } catch (e) {
    return res.status(500).json({ error: "Redis error", detail: String(e?.message || e) });
  }
}
