const fetch = require("node-fetch");

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

function clean(s = "") {
  return s.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(official|audio|video|lyrics|feat|ft|full|hd|remix|cover|live|from)\b/g, "")
    .replace(/\s+/g, " ").trim();
}

// ✅ Album number fix added
function bestMatch(list, title, artist, album) {
  const tT     = clean(title);
  const tA     = clean(artist || "");
  const tAl    = clean(album  || "");

  // (From "...") hatao title se
  const tTMain = tT.replace(/\(from[^)]*\)/gi, "").trim();

  // Album number nikalo - "Rabb Da Radio 2" → "2"
  const albumNum = (tAl.match(/\d+/) || [])[0] || "";

  const scored = list.map(r => {
    const rT   = clean(r.name   || "");
    const rA   = clean(r.artist || "");
    const rAl  = clean(r.album  || "");
    let sc     = 0;

    const rTMain = rT.replace(/\(from[^)]*\)/gi, "").trim();

    // ── Title Score ──────────────────────────────
    if (rTMain === tTMain)               sc += 100;
    else if (rT === tT)                  sc += 100;
    else if (rT.includes(tTMain))        sc += 70;
    else if (tTMain.includes(rTMain))    sc += 50;
    else {
      const tw = tTMain.split(" ").filter(w => w.length > 2);
      const rw = rTMain.split(" ").filter(w => w.length > 2);
      const matches = tw.filter(w => rw.includes(w));
      sc += matches.length * 15;
      // Half se kam words match → penalty
      if (matches.length < tw.length / 2) sc -= 25;
    }

    // ── Artist Score ─────────────────────────────
    if (tA) {
      if (rA === tA)              sc += 50;
      else if (rA.includes(tA))   sc += 35;
      else if (tA.includes(rA))   sc += 25;
      else {
        const aw  = tA.split(" ").filter(w => w.length > 2);
        const rw2 = rA.split(" ").filter(w => w.length > 2);
        sc += aw.filter(w => rw2.includes(w)).length * 10;
      }
    }

    // ── Album Number Score ────────────────────────
    // ✅ "Rabb Da Radio 2" vs "Rabb Da Radio 3" fix
    if (albumNum) {
      const rAlNum = (rAl.match(/\d+/) || [])[0] || "";
      const rTNum  = (rT.match(/\d+/)  || [])[0] || "";

      if (rAlNum === albumNum || rTNum === albumNum) {
        sc += 40;  // ✅ Sahi album number - bonus
      } else if (
        (rAlNum && rAlNum !== albumNum) ||
        (rTNum  && rTNum  !== albumNum)
      ) {
        sc -= 50;  // ❌ Galat album number - heavy penalty
      }
    }

    return { r, sc };
  });

  scored.sort((a, b) => b.sc - a.sc);

  // Debug
  console.log("   Top 3 matches:");
  scored.slice(0, 3).forEach(s => {
    console.log(`     "${s.r.name}" | artist="${s.r.artist}" | album="${s.r.album}" | sc=${s.sc}`);
  });

  return scored[0] || null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { title, artist, album } = req.query; // ✅ album add kiya
  if (!title) return res.status(400).json({ error: "title required" });

  console.log(`\n🎵 Saavn: "${title}" — ${artist || "?"} | Album: "${album || "?"}"`);

  // ✅ Search query mein album bhi add karo
  const q = `${title} ${artist || ""} ${album || ""}`.trim();

  const APIS = [
    `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(q)}`,
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=10`,
  ];

  for (const apiUrl of APIS) {
    try {
      console.log("   Trying: " + apiUrl.substring(0, 65) + "...");
      const r = await fetchWithTimeout(
        apiUrl,
        { headers: { "User-Agent": "Mozilla/5.0" } },
        8000
      );
      if (!r.ok) continue;
      const data = await r.json();

      let results = [];

      // API 1 - Array format
      if (Array.isArray(data)) {
        results = data.map(s => ({
          name:   s.song   || s.name   || "",
          artist: s.singers || s.artist || "",
          album:  s.album  || "",
          url:    s.media_url || s.url  || null,
        })).filter(s => s.name && s.url);
      } else {
        // API 2 - Object format
        const songs = data?.data?.results || data?.results || [];
        results = songs.map(s => {
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
            name:   s.name || s.song || "",
            artist: Array.isArray(s.artists?.primary)
                      ? s.artists.primary.map(a => a.name).join(", ")
                      : s.primaryArtists || s.singers || "",
            album:  s.album?.name || s.album || "", // ✅ album field add
            url,
          };
        }).filter(s => s.name && s.url);
      }

      console.log(`   Results: ${results.length}`);
      if (!results.length) continue;

      // ✅ album pass karo bestMatch mein
      const match = bestMatch(results, title, artist, album);
      if (!match || match.sc < 60) {
        console.log(`   ❌ Score too low: ${match?.sc} — trying next API`);
        continue;
      }

      const audioUrl = match.r.url.replace(/^http:\/\//i, "https://");
      console.log(`   ✅ Matched: "${match.r.name}" score=${match.sc}`);
      return res.json({
        success: true,
        url:     audioUrl,
        matched: match.r.name,
        artist:  match.r.artist,
        score:   match.sc,
      });

    } catch (e) {
      console.log("   API failed: " + e.message);
      continue;
    }
  }

  console.log("   ❌ Not found on any API");
  return res.json({ success: false, url: null, reason: "Not found" });
};