export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const { homepage = "", stream = "", name = "" } = req.query || {};

    const clean = (s) => String(s || "").trim();
    const hp = clean(homepage);
    const st = clean(stream);

    const looksLikeHttp = (u) => /^https?:\/\//i.test(u || "");
    const isLikelyAudioUrl = (u) =>
      /(\.m3u8?|\.(pls))(\?|#|$)/i.test(u) ||
      /(\/stream\b|\/listen\b|\/live\b|\/radio\b|icecast|shoutcast|:8\d{2,3}\/|:2\d{3,4}\/)/i.test(u);

    const isJunk = (u) =>
      /\.(jpg|jpeg|png|webp|gif|svg|css|js|pdf|zip)(\?|#|$)/i.test(u) ||
      /(\/news\b|\/blog\b|\/events\b|\/programs\b|\/artists\b|\/videos\b|\/music\b|\/article\b)/i.test(u);

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];

    const timeoutFetch = async (url, opts = {}, ms = 7000) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
        clearTimeout(t);
        return r;
      } catch {
        clearTimeout(t);
        return null;
      }
    };

    const probe = async (url) => {
      // HEAD si possible
      let r = await timeoutFetch(url, { method: "HEAD" }, 5500);
      if (r && r.ok) {
        const ct = r.headers.get("content-type") || "";
        if (/audio\/|application\/ogg|mpegurl|x-mpegurl/i.test(ct) || /\.m3u8?(\?|#|$)/i.test(url) || /\.pls(\?|#|$)/i.test(url)) {
          return { ok: true, ct };
        }
      }
      // GET range très court (marche mieux que HEAD sur pas mal de serveurs)
      r = await timeoutFetch(url, { method: "GET", headers: { Range: "bytes=0-2047" } }, 7000);
      if (r && (r.ok || r.status === 206)) {
        const ct = r.headers.get("content-type") || "";
        if (/audio\/|application\/ogg|mpegurl|x-mpegurl/i.test(ct) || /\.m3u8?(\?|#|$)/i.test(url) || /\.pls(\?|#|$)/i.test(url)) {
          return { ok: true, ct };
        }
      }
      return { ok: false, ct: "" };
    };

    const parsePlaylist = async (playlistUrl) => {
      const r = await timeoutFetch(playlistUrl, { method: "GET" }, 8000);
      if (!r || !r.ok) return [];
      const txt = await r.text();

      // M3U
      if (/^#EXTM3U/i.test(txt) || /\.m3u8?(\?|#|$)/i.test(playlistUrl)) {
        return uniq(
          txt.split("\n")
            .map((l) => l.trim())
            .filter((l) => looksLikeHttp(l) && !l.startsWith("#"))
        );
      }

      // PLS
      if (/^\[playlist\]/i.test(txt) || /\.pls(\?|#|$)/i.test(playlistUrl)) {
        const out = [];
        const re = /^File\d+=(.+)$/gim;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const u = clean(m[1]);
          if (looksLikeHttp(u)) out.push(u);
        }
        return uniq(out);
      }
      return [];
    };

    const toAbs = (base, href) => {
      try { return new URL(href, base).toString(); } catch { return null; }
    };

    // 1) candidates de base (stream direct + https variant)
    let candidates = [];
    if (looksLikeHttp(st)) candidates.push(st);
    if (looksLikeHttp(st)) {
      try {
        const u = new URL(st);
        if (u.protocol === "http:") { u.protocol = "https:"; candidates.push(u.toString()); }
      } catch {}
    }

    // 2) heuristique: si on a une homepage, analyser le HTML + scripts (pas crawler des pages)
    if (looksLikeHttp(hp)) {
      const page = await timeoutFetch(hp, { method: "GET" }, 9000);
      if (page && page.ok) {
        const html = await page.text();

        // a) récupérer href/src seulement si ça ressemble à un flux/playlist/player
        const hrefs = [];
        const reAttr = /(href|src)\s*=\s*["']([^"']+)["']/gim;
        let m;
        while ((m = reAttr.exec(html)) !== null) {
          const raw = clean(m[2]);
          const abs = toAbs(hp, raw);
          if (!abs) continue;
          if (!looksLikeHttp(abs)) continue;
          if (isJunk(abs)) continue;
          if (isLikelyAudioUrl(abs)) hrefs.push(abs);
        }

        // b) extraire URLs “cachées” dans le JS (ex: play.xxx.com:PORT/stream)
        const jsUrls = [];
        const reUrl = /https?:\/\/[^\s"'<>]+/gim;
        const all = html.match(reUrl) || [];
        for (const u of all) {
          const cu = clean(u).replace(/[),;]+$/g, "");
          if (!looksLikeHttp(cu)) continue;
          if (isJunk(cu)) continue;
          if (isLikelyAudioUrl(cu)) jsUrls.push(cu);
        }

        candidates.push(...hrefs, ...jsUrls);

        // c) favicons (parfois utile si domaine différent / mais ici on garde très bas)
        try {
          const base = new URL(hp);
          candidates.push(`${base.origin}/stream`);
          candidates.push(`${base.origin}/listen`);
          candidates.push(`${base.origin}/live`);
        } catch {}
      }
    }

    // 3) heuristique “subdomains audio” à partir du domaine homepage (play., stream., radio.)
    if (looksLikeHttp(hp)) {
      try {
        const u = new URL(hp);
        const host = u.hostname.replace(/^www\./, "");
        const originProto = u.protocol;
        const guesses = [
          `${originProto}//play.${host}/stream`,
          `${originProto}//stream.${host}/stream`,
          `${originProto}//radio.${host}/stream`,
          `${originProto}//live.${host}/stream`,
        ];
        candidates.push(...guesses);
      } catch {}
    }

    // Nettoyage + priorité: d’abord URLs qui ressemblent à playlist/stream
    candidates = uniq(candidates)
      .filter(looksLikeHttp)
      .filter((u) => !isJunk(u))
      .filter((u) => isLikelyAudioUrl(u) || /\.m3u8?(\?|#|$)/i.test(u) || /\.pls(\?|#|$)/i.test(u))
      .slice(0, 50);

    const tried = [];

    // 4) tester candidates
    for (const url of candidates) {
      tried.push(url);

      // playlists → parser puis tester les URLs internes
      if (/\.(m3u8?|pls)(\?|#|$)/i.test(url)) {
        const p = await probe(url);
        if (p.ok) {
          const inside = await parsePlaylist(url);
          for (const u of inside.slice(0, 12)) {
            const pr = await probe(u);
            if (pr.ok) {
              return res.status(200).json({ ok: true, url: u, source: "playlist", name });
            }
          }
        }
        continue;
      }

      // stream direct
      const p = await probe(url);
      if (p.ok) {
        return res.status(200).json({ ok: true, url, source: "direct", name });
      }
    }

    return res.status(200).json({
      ok: false,
      url: null,
      reason: "no_working_stream_found",
      tried: tried.slice(0, 20),
      name
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
}
