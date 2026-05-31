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
    .replace(/\b(official|audio|video|lyrics|feat|ft|full|hd|remix|cover|live)\b/g, "")
    .replace(/\s+/g, " ").trim();
}

function bestMatch(list, title, artist) {
  const tT = clean(title);
  const tA = clean(artist || "");
  const scored = list.map(r => {
    const rT = clean(r.name);
    const rA = clean(r.artist);
    let sc = 0;
    if (rT === tT)            sc += 100;
    else if (rT.includes(tT)) sc += 70;
    else if (tT.includes(rT)) sc += 50;
    else {
      const tw = tT.split(" ").filter(w => w.length > 2);
      const rw = rT.split(" ").filter(w => w.length > 2);
      sc += tw.filter(w => rw.includes(w)).length * 15;
    }
    if (tA) {
      if (rA === tA)            sc += 50;
      else if (rA.includes(tA)) sc += 35;
      else if (tA.includes(rA)) sc += 25;
    }
    return { r, sc };
  });
  scored.sort((a, b) => b.sc - a.sc);
  return scored[0] || null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });

  const APIS = [
    `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(title + " " + (artist || ""))}`,
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(title + " " + (artist || ""))}&page=1&limit=10`,
  ];

  for (const apiUrl of APIS) {
    try {
      const r = await fetchWithTimeout(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
      if (!r.ok) continue;
      const data = await r.json();

      let results = [];

      if (Array.isArray(data)) {
        results = data.map(s => ({
          name: s.song || s.name || "",
          artist: s.singers || s.artist || "",
          url: s.media_url || s.url || null,
        })).filter(s => s.name && s.url);
      } else {
        const songs = data?.data?.results || data?.results || [];
        results = songs.map(s => {
          let url = null;
          if (Array.isArray(s.downloadUrl)) {
            const best = s.downloadUrl.find(d => d.quality === "320kbps")
                      || s.downloadUrl[s.downloadUrl.length - 1];
            url = best?.url || null;
          } else {
            url = s.downloadUrl || s.url || null;
          }
          return {
            name: s.name || s.song || "",
            artist: Array.isArray(s.artists?.primary)
              ? s.artists.primary.map(a => a.name).join(", ")
              : s.primaryArtists || s.singers || "",
            url,
          };
        }).filter(s => s.name && s.url);
      }

      if (!results.length) continue;

      const match = bestMatch(results, title, artist);
      if (!match || match.sc < 30) continue;

      const audioUrl = match.r.url.replace(/^http:\/\//i, "https://");
      return res.json({ success: true, url: audioUrl, matched: match.r.name, score: match.sc });

    } catch (e) { continue; }
  }

  return res.json({ success: false, url: null, reason: "Not found" });
};