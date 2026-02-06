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
    const hasTemplate = (u) => /\$\{|\%\7B|\{encodeURIComponent/i.test(u || "");
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

    const isAudioCt = (ct) =>
      /audio\/|application\/ogg|mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(ct || "");

    const isPlaylistUrl = (u) => /\.(m3u8?|pls)(\?|#|$)/i.test(u || "");

    const probe = async (url) => {
      // HEAD
      let r = await timeoutFetch(url, { method: "HEAD" }, 5500);
      if (r && r.ok) {
        const ct = r.headers.get("content-type") || "";
        if (isAudioCt(ct) || isPlaylistUrl(url)) return { ok: true, ct };
      }
      // GET range short
      r = await timeoutFetch(url, { method: "GET", headers: { Range: "bytes=0-2047" } }, 7000);
      if (r && (r.ok || r.status === 206)) {
        const ct = r.headers.get("content-type") || "";
        if (isAudioCt(ct) || isPlaylistUrl(url)) return { ok: true, ct };
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
            .filter((l) => looksLikeHttp(l) && !l.startsWith("#") && !hasTemplate(l))
        );
      }

      // PLS
      if (/^\[playlist\]/i.test(txt) || /\.pls(\?|#|$)/i.test(playlistUrl)) {
        const out = [];
        const re = /^File\d+=(.+)$/gim;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const u = clean(m[1]);
          if (looksLikeHttp(u) && !hasTemplate(u)) out.push(u);
        }
        return uniq(out);
      }
      return [];
    };

    const toAbs = (base, href) => {
      try { return new URL(href, base).toString(); } catch { return null; }
    };

    const isJunk = (u) =>
      hasTemplate(u) ||
      /\.(jpg|jpeg|png|webp|gif|svg|css|js|pdf|zip)(\?|#|$)/i.test(u) ||
      /(\/news\b|\/blog\b|\/events\b|\/programs\b|\/artists\b|\/videos\b|\/music\b|\/article\b)/i.test(u);

    const isLikelyAudioUrl = (u) =>
      isPlaylistUrl(u) ||
      /(\/stream\b|\/listen\b|\/live\b|\/radio\b|icecast|shoutcast|:8\d{2,3}\/|:2\d{3,4}\/|\/;)/i.test(u);

    // ---------- Build candidates ----------
    let candidates = [];

    // A) Stream provided (even if wrong path)
    if (looksLikeHttp(st) && !isJunk(st)) candidates.push(st);

    // A2) Try same ORIGIN (host + port) with common mountpoints
    if (looksLikeHttp(st)) {
      try {
        const u = new URL(st);
        const origin = u.origin; // includes port
        const common = [
          `${origin}/stream`,
          `${origin}/listen`,
          `${origin}/live`,
          `${origin}/;`,
          `${origin}/status-json.xsl`,
          `${origin}/status-json`,
        ];
        candidates.push(...common);

        // If path had something, try stripping it to parent mount
        if (u.pathname && u.pathname.length > 1) {
          const parts = u.pathname.split("/").filter(Boolean);
          if (parts.length >= 2) {
            candidates.push(`${origin}/${parts[0]}`); // first segment as mount
          }
        }
      } catch {}
    }

    // B) Parse homepage HTML (only stream-like URLs, no crawling)
    if (looksLikeHttp(hp)) {
      const page = await timeoutFetch(hp, { method: "GET" }, 9000);
      if (page && page.ok) {
        const html = await page.text();

        // href/src attributes
        const found = [];
        const reAttr = /(href|src)\s*=\s*["']([^"']+)["']/gim;
        let m;
        while ((m = reAttr.exec(html)) !== null) {
          const abs = toAbs(hp, clean(m[2]));
          if (!abs || !looksLikeHttp(abs) || isJunk(abs)) continue;
          if (isLikelyAudioUrl(abs)) found.push(abs);
        }

        // raw URLs inside scripts
        const reUrl = /https?:\/\/[^\s"'<>]+/gim;
        const all = html.match(reUrl) || [];
        for (const raw of all) {
          const u = clean(raw).replace(/[),;]+$/g, "");
          if (!looksLikeHttp(u) || isJunk(u)) continue;
          if (isLikelyAudioUrl(u)) found.push(u);
        }

        candidates.push(...found);

        // same-origin quick guesses
        try {
          const base = new URL(hp);
          candidates.push(`${base.origin}/stream`, `${base.origin}/listen`, `${base.origin}/live`, `${base.origin}/;`);
          candidates.push(`${base.origin}/status-json.xsl`, `${base.origin}/status-json`);
        } catch {}
      }
    }

    // C) Subdomain guesses from homepage
    if (looksLikeHttp(hp)) {
      try {
        const u = new URL(hp);
        const host = u.hostname.replace(/^www\./, "");
        const proto = u.protocol;
        candidates.push(
          `${proto}//play.${host}/stream`,
          `${proto}//stream.${host}/stream`,
          `${proto}//radio.${host}/stream`,
          `${proto}//live.${host}/stream`
        );
      } catch {}
    }

    // Clean + prioritize
    candidates = uniq(candidates)
      .filter(looksLikeHttp)
      .filter((u) => !isJunk(u))
      .filter((u) => isLikelyAudioUrl(u))
      .slice(0, 70);

    const tried = [];

    // ---------- Try candidates ----------
    for (const url of candidates) {
      tried.push(url);

      // Icecast status-json: extract listenurl(s)
      if (url.endsWith("/status-json.xsl") || url.endsWith("/status-json")) {
        const r = await timeoutFetch(url, { method: "GET" }, 6500);
        if (r && r.ok) {
          try {
            const data = await r.json();
            const ic = data.icestats || data;
            const src = ic.source;
            const pick = (s) => clean(s.listenurl || s.url || "");
            const listenUrls = [];
            if (Array.isArray(src)) src.forEach((s) => listenUrls.push(pick(s)));
            else if (src) listenUrls.push(pick(src));
            for (const u of uniq(listenUrls).filter(looksLikeHttp)) {
              const pr = await probe(u);
              if (pr.ok) return res.status(200).json({ ok: true, url: u, source: "icecast-status", name });
            }
          } catch {}
        }
        continue;
      }

      // Playlist → parse → probe inner urls
      if (isPlaylistUrl(url)) {
        const p = await probe(url);
        if (p.ok) {
          const inside = await parsePlaylist(url);
          for (const u of inside.slice(0, 14)) {
            const pr = await probe(u);
            if (pr.ok) return res.status(200).json({ ok: true, url: u, source: "playlist", name });
          }
        }
        continue;
      }

      // Direct stream
      const p = await probe(url);
      if (p.ok) return res.status(200).json({ ok: true, url, source: "direct", name });
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
