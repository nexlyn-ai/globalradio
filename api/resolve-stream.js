export default async function handler(req, res) {
  try {
    // CORS permissif (utile si tu testes ailleurs)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const { homepage = "", stream = "", name = "" } = req.query || {};

    // Helpers
    const timeoutFetch = async (url, opts = {}, ms = 7000) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
        clearTimeout(t);
        return r;
      } catch (e) {
        clearTimeout(t);
        return null;
      }
    };

    const toAbs = (base, href) => {
      try {
        return new URL(href, base).toString();
      } catch {
        return null;
      }
    };

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];

    const clean = (s) => String(s || "").trim();

    const looksLikeStream = (u) => {
      const s = String(u || "");
      return (
        s.startsWith("http://") ||
        s.startsWith("https://")
      );
    };

    const isPlaylist = (u) => /\.(m3u8?|pls)(\?|#|$)/i.test(u);
    const isAudio = (ct) => /audio\/|application\/ogg|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(ct || "");

    // Test “légers” (certains serveurs bloquent HEAD, donc fallback GET range)
    const probe = async (url) => {
      // 1) HEAD
      let r = await timeoutFetch(url, { method: "HEAD" }, 6000);
      if (r && r.ok) {
        const ct = r.headers.get("content-type") || "";
        const cl = r.headers.get("content-length");
        if (isAudio(ct) || isPlaylist(url) || (cl && Number(cl) > 0)) return { ok: true, ct };
      }

      // 2) GET range (très court)
      r = await timeoutFetch(
        url,
        { method: "GET", headers: { Range: "bytes=0-2047" } },
        7000
      );
      if (r && (r.ok || r.status === 206)) {
        const ct = r.headers.get("content-type") || "";
        if (isAudio(ct) || isPlaylist(url)) return { ok: true, ct };
      }
      return { ok: false, ct: "" };
    };

    const parsePlaylistForStream = async (playlistUrl) => {
      const r = await timeoutFetch(playlistUrl, { method: "GET" }, 8000);
      if (!r || !r.ok) return [];
      const txt = await r.text();

      // M3U: lignes http(s)
      if (/^#EXTM3U/i.test(txt) || playlistUrl.match(/\.m3u8?/i)) {
        return uniq(
          txt.split("\n")
            .map(l => l.trim())
            .filter(l => looksLikeStream(l) && !l.startsWith("#"))
        );
      }

      // PLS
      if (playlistUrl.match(/\.pls/i) || /\[playlist\]/i.test(txt)) {
        const out = [];
        const re = /^File\d+=(.+)$/gim;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const u = clean(m[1]);
          if (looksLikeStream(u)) out.push(u);
        }
        return uniq(out);
      }

      return [];
    };

    // Collect candidates
    const candidates = [];

    // (A) stream original en priorité (au cas où, mais on teste surtout alternatives)
    if (looksLikeStream(stream)) candidates.push(stream);

    // (B) variantes simples (http->https, enlever proxy, etc.)
    if (looksLikeStream(stream)) {
      try {
        const u = new URL(stream);
        if (u.protocol === "http:") {
          u.protocol = "https:";
          candidates.push(u.toString());
        }
      } catch {}
    }

    // (C) chercher sur la homepage : liens .m3u/.pls et endpoints connus
    const hp = clean(homepage);
    if (hp && looksLikeStream(hp)) {
      const page = await timeoutFetch(hp, { method: "GET" }, 9000);
      if (page && page.ok) {
        const html = await page.text();

        // liens playlists
        const hrefs = [];
        const reHref = /href\s*=\s*["']([^"']+)["']/gim;
        let m;
        while ((m = reHref.exec(html)) !== null) hrefs.push(m[1]);

        const abs = uniq(hrefs.map(h => toAbs(hp, h)));

        // garder playlists et liens qui ressemblent à des streams
        const playlistLinks = abs.filter(u => isPlaylist(u));
        const streamishLinks = abs.filter(u => /\/stream|\/listen|\/live|icecast|shoutcast|\/radio/i.test(u));

        candidates.push(...playlistLinks);
        candidates.push(...streamishLinks);

        // endpoints icecast fréquents (si la radio a un serveur icecast sur le même host)
        try {
          const base = new URL(hp);
          const origin = base.origin;
          candidates.push(origin + "/status-json.xsl");
          candidates.push(origin + "/status-json");
        } catch {}
      }
    }

    // Nettoyage / priorisation
    const ordered = uniq(candidates)
      .filter(u => looksLikeStream(u))
      // virer les “pages” html évidentes
      .filter(u => !u.match(/\.(jpg|jpeg|png|webp|gif|svg|css|js)(\?|#|$)/i))
      .slice(0, 60);

    // Logique:
    // 1) tester playlists (.m3u/.pls) -> si ok, parser -> tester URL internes
    // 2) tester streams directs
    const tried = [];
    const testedOk = [];

    for (const url of ordered) {
      tried.push(url);

      // Si c'est status-json icecast, on tente d'en extraire un titre / source mais pas indispensable ici.
      // Ici: on vise surtout à récupérer une URL de flux.
      if (url.endsWith("/status-json.xsl") || url.endsWith("/status-json")) {
        // On peut en tirer "source.listenurl"
        const r = await timeoutFetch(url, { method: "GET" }, 6000);
        if (r && r.ok) {
          try {
            const data = await r.json();
            const ic = data.icestats || data;
            const src = ic.source;
            const pick = (s) => clean(s.listenurl || s.url || "");
            if (Array.isArray(src)) {
              src.forEach(s => testedOk.push(pick(s)));
            } else if (src) {
              testedOk.push(pick(src));
            }
          } catch {}
        }
        continue;
      }

      if (isPlaylist(url)) {
        const p = await probe(url);
        if (p.ok) {
          const inside = await parsePlaylistForStream(url);
          for (const u of inside.slice(0, 10)) {
            const pr = await probe(u);
            if (pr.ok) {
              return res.status(200).json({
                ok: true,
                url: u,
                source: "playlist",
                name
              });
            }
          }
        }
        continue;
      }

      // streams directs
      const p = await probe(url);
      if (p.ok) {
        // Si c'est une page html mais avec content-type audio, ok.
        return res.status(200).json({
          ok: true,
          url,
          source: "direct",
          name
        });
      }
    }

    // Dernière passe: URLs extraites depuis status-json icecast
    const extra = uniq(testedOk).filter(looksLikeStream).slice(0, 20);
    for (const u of extra) {
      const p = await probe(u);
      if (p.ok) {
        return res.status(200).json({
          ok: true,
          url: u,
          source: "icecast-status",
          name
        });
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
