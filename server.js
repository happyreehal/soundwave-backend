const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fetch   = require("node-fetch");

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ─────────────────────────────────────────────
   HELPER — fetch with timeout
───────────────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────────────────────
   JIOSAAVN — using saavnapi.vercel.app
   (open source unofficial API, actually works)
───────────────────────────────────────────── */
async function saavnSearch(query, limit = 10) {
  // Multiple API endpoints as fallback
  const APIS = [
    `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(query)}`,
    `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}&page=1&limit=${limit}`,
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&page=1&limit=${limit}`,
  ];

  for (const apiUrl of APIS) {
    try {
      console.log(`   Trying: ${apiUrl.substring(0, 60)}...`);
      const res = await fetchWithTimeout(apiUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      }, 8000);

      if (!res.ok) continue;
      const data = await res.json();

      // saavnapi-nine format
      if (Array.isArray(data)) {
        const results = data
          .map(s => ({
            id:       s.id,
            name:     s.song     || s.name  || "",
            artist:   s.singers  || s.artist || s.primaryArtists || "",
            album:    s.album    || "",
            url:      s.media_url || s.url   || null,
            duration: s.duration || 0,
          }))
          .filter(s => s.name && s.url);
        if (results.length > 0) {
          console.log(`   ✅ API1 returned ${results.length} results`);
          return results;
        }
      }

      // saavn.dev / jiosaavn-api format
      const songs = data?.data?.results || data?.results || [];
      if (songs.length > 0) {
        const results = songs
          .map(s => {
            // downloadUrl array — pick highest quality
            let url = null;
            if (Array.isArray(s.downloadUrl)) {
              const best = s.downloadUrl.find(d => d.quality === "320kbps")
                        || s.downloadUrl.find(d => d.quality === "160kbps")
                        || s.downloadUrl[s.downloadUrl.length - 1];
              url = best?.url || null;
            } else {
              url = s.downloadUrl || s.url || null;
            }

            return {
              id:       s.id,
              name:     s.name    || s.song    || "",
              artist:   (Array.isArray(s.artists?.primary)
                          ? s.artists.primary.map(a => a.name).join(", ")
                          : s.primaryArtists || s.singers || ""),
              album:    s.album?.name || s.album || "",
              url:      url,
              duration: s.duration || 0,
            };
          })
          .filter(s => s.name && s.url);

        if (results.length > 0) {
          console.log(`   ✅ API2/3 returned ${results.length} results`);
          return results;
        }
      }

    } catch (e) {
      console.log(`   ❌ API failed: ${e.message}`);
      continue;
    }
  }

  return [];
}

/* ─────────────────────────────────────────────
   MATCH HELPER
───────────────────────────────────────────── */
function clean(s = "") {
  return s.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(official|audio|video|lyrics|feat|ft|full|hd|remix|cover|live)\b/g, "")
    .replace(/\s+/g, " ").trim();
}

function bestMatch(list, title, artist) {
  const tT = clean(title);
  const tA = clean(artist || "");

  const scored = list.map(r => {
    const rT = clean(r.name);
    const rA = clean(r.artist);
    let sc   = 0;

    if (rT === tT)             sc += 100;
    else if (rT.includes(tT))  sc += 70;
    else if (tT.includes(rT))  sc += 50;
    else {
      const tw = tT.split(" ").filter(w => w.length > 2);
      const rw = rT.split(" ").filter(w => w.length > 2);
      sc += tw.filter(w => rw.includes(w)).length * 15;
    }

    if (tA) {
      if (rA === tA)             sc += 50;
      else if (rA.includes(tA))  sc += 35;
      else if (tA.includes(rA))  sc += 25;
    }

    return { r, sc };
  });

  scored.sort((a, b) => b.sc - a.sc);
  return scored[0] || null;
}

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */

// ── JioSaavn stream URL
app.get("/api/saavn/stream", async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });

  console.log(`\n🎵 Saavn: "${title}" — ${artist || "unknown"}`);

  try {
    const q       = `${title} ${artist || ""}`.trim();
    const results = await saavnSearch(q);

    console.log(`   Found ${results.length} results`);

    if (!results.length) {
      return res.json({ success: false, url: null, reason: "No results from any API" });
    }

    const match = bestMatch(results, title, artist);
    if (!match || match.sc < 30) {
      return res.json({ success: false, url: null, reason: "No good match" });
    }

    const song     = match.r;
    const audioUrl = song.url.replace(/^http:\/\//i, "https://");

    console.log(`   ✅ "${song.name}" score=${match.sc}`);
    console.log(`   URL: ${audioUrl.substring(0, 70)}...`);

    res.json({
      success: true,
      url:     audioUrl,
      matched: song.name,
      artist:  song.artist,
      score:   match.sc,
    });

  } catch (e) {
    console.error("   ❌ Saavn error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Audius proxy (avoids browser CORS issues)
app.get("/api/audius/stream", async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });

  const NODES = [
    "https://discoveryprovider.audius.co",
    "https://discoveryprovider2.audius.co",
    "https://discoveryprovider3.audius.co",
  ];

  function cleanStr(s = "") {
    return s.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\b(official|audio|video|lyrics|feat|ft|featuring|hd|remix|cover|live|version|acoustic)\b/g, "")
      .replace(/\s+/g, " ").trim();
  }

  const tT = cleanStr(title);
  const tA = cleanStr(artist || "");

  for (const node of NODES) {
    try {
      const searchRes = await fetchWithTimeout(
        `${node}/v1/tracks/search?query=${encodeURIComponent(title + " " + (artist || ""))}&limit=10&app_name=SoundWavePro`,
        {},
        6000
      );
      if (!searchRes.ok) continue;

      const data   = await searchRes.json();
      const tracks = data?.data || [];
      if (!tracks.length) continue;

      const scored = tracks.map(t => {
        const iT = cleanStr(t.title || "");
        const iA = cleanStr(t.user?.name || "");
        let score = 0;
        if (iT === tT)            score += 100;
        else if (iT.includes(tT)) score += 70;
        else if (tT.includes(iT)) score += 50;
        else {
          const tw = tT.split(" ").filter(w => w.length > 2);
          const iw = iT.split(" ").filter(w => w.length > 2);
          score += tw.filter(w => iw.includes(w)).length * 15;
        }
        if (iA === tA)            score += 50;
        else if (iA.includes(tA)) score += 35;
        else if (tA.includes(iA)) score += 25;
        return { t, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 50) continue;

      const streamUrl = `${node}/v1/tracks/${best.t.id}/stream?app_name=SoundWavePro`;
      console.log(`   ✅ Audius: "${best.t.title}" score=${best.score}`);
      return res.json({ success: true, url: streamUrl, matched: best.t.title });

    } catch (e) {
      continue;
    }
  }

  res.json({ success: false, url: null, reason: "Not found on Audius" });
});

// ── iTunes search
app.get("/api/search", async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`;
    const resp = await fetchWithTimeout(url, {}, 8000);
    const data = await resp.json();

    const results = (data.results || [])
      .filter(t => t.trackId && t.trackName)
      .map(t => ({
        id:         String(t.trackId),
        title:      t.trackName        || "Unknown",
        artist:     t.artistName       || "Unknown",
        album:      t.collectionName   || "Unknown",
        duration:   Math.round((t.trackTimeMillis || 0) / 1000),
        previewUrl: t.previewUrl       || null,
        artwork:    (t.artworkUrl100   || "")
                    .replace("100x100bb", "600x600bb")
                    .replace("100x100",   "600x600"),
        genre:      t.primaryGenreName || "Music",
        explicit:   t.trackExplicitness === "explicit",
        itunesUrl:  t.trackViewUrl     || "#",
        source:     "itunes",
      }));

    console.log(`iTunes: ${results.length} for "${q}"`);
    res.json({ success: true, results });

  } catch (e) {
    res.json({ success: false, results: [], error: e.message });
  }
});

// ── Health check
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", port: PORT });
});

// ── Serve app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════╗
║  🎵 SoundWave Pro               ║
║  http://localhost:${PORT}           ║
╚══════════════════════════════════╝`);
}).on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log(`\n❌ Port ${PORT} busy! Run: npx kill-port ${PORT}\n`);
    process.exit(1);
  }
});