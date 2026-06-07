const fetch = require("node-fetch");

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, ms = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clean(s = "") {
  return s.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(official|audio|video|lyrics|feat|ft|full|hd|remix|cover|live|from|the)\b/g, "")
    .replace(/\s+/g, " ").trim();
}

/* Levenshtein for fuzzy matching */
function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/* ─────────────────────────────────────────────
   BEST MATCH
───────────────────────────────────────────── */
function bestMatch(list, title, artist, album) {
  const tT = clean(title);
  const tA = clean(artist || "");
  const tAl = clean(album || "");
  const tTMain = tT.replace(/\(from[^)]*\)/gi, "").trim();
  const albumNum = (tAl.match(/\d+/) || [])[0] || "";

  const scored = list.map(r => {
    const rT = clean(r.name || "");
    const rA = clean(r.artist || "");
    const rAl = clean(r.album || "");
    let sc = 0;
    const rTMain = rT.replace(/\(from[^)]*\)/gi, "").trim();

    /* Title Score */
    if (rTMain === tTMain) sc += 100;
    else if (rT === tT) sc += 100;
    else if (rT.includes(tTMain)) sc += 75;
    else if (tTMain.includes(rTMain)) sc += 55;
    else {
      const sim = similarity(rTMain, tTMain);
      if (sim > 0.8) sc += 80;
      else if (sim > 0.6) sc += 50;
      else if (sim > 0.4) sc += 25;

      const tw = tTMain.split(" ").filter(w => w.length > 2);
      const rw = rTMain.split(" ").filter(w => w.length > 2);
      const matches = tw.filter(w =>
        rw.some(rWord => similarity(w, rWord) > 0.75)
      );
      sc += matches.length * 12;
      if (matches.length < tw.length / 2 && sim < 0.5) sc -= 15;
    }

    /* Artist Score */
    if (tA) {
      if (rA === tA) sc += 50;
      else if (rA.includes(tA)) sc += 38;
      else if (tA.includes(rA)) sc += 28;
      else {
        const aSim = similarity(rA, tA);
        if (aSim > 0.8) sc += 40;
        else if (aSim > 0.6) sc += 25;

        const aw = tA.split(" ").filter(w => w.length > 2);
        const rw2 = rA.split(" ").filter(w => w.length > 2);
        const matches = aw.filter(w =>
          rw2.some(rWord => similarity(w, rWord) > 0.75)
        );
        sc += matches.length * 8;
      }
    }

    /* Album Number Score */
    if (albumNum) {
      const rAlNum = (rAl.match(/\d+/) || [])[0] || "";
      const rTNum = (rT.match(/\d+/) || [])[0] || "";
      if (rAlNum === albumNum || rTNum === albumNum) sc += 40;
      else if ((rAlNum && rAlNum !== albumNum) || (rTNum && rTNum !== albumNum)) sc -= 50;
    }

    return { r, sc };
  });

  scored.sort((a, b) => b.sc - a.sc);

  console.log("   Top 3 matches:");
  scored.slice(0, 3).forEach(s => {
    console.log(`     "${s.r.name}" | "${s.r.artist}" | sc=${s.sc}`);
  });

  return scored[0] || null;
}

/* ─────────────────────────────────────────────
   Try one API with retry
───────────────────────────────────────────── */
async function tryApi(apiUrl, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(
        apiUrl,
        { headers: { "User-Agent": "Mozilla/5.0" } },
        7000
      );

      if (r.status === 429) {
        console.log(`   ⚠️ 429 rate limit (attempt ${attempt})`);
        if (attempt < retries) {
          await sleep(600 * attempt);
          continue;
        }
        return null;
      }

      if (!r.ok) {
        console.log(`   HTTP ${r.status}`);
        return null;
      }

      return await r.json();
    } catch (e) {
      console.log(`   API error (attempt ${attempt}): ${e.message}`);
      if (attempt < retries) await sleep(400);
    }
  }
  return null;
}

/* ─────────────────────────────────────────────
   Extract songs from various API response formats
───────────────────────────────────────────── */
function extractSongs(data) {
  let results = [];

  // Format 1: Array (saavnapi-nine)
  if (Array.isArray(data)) {
    results = data.map(s => ({
      name:   s.song || s.name || "",
      artist: s.singers || s.artist || "",
      album:  s.album || "",
      url:    s.media_url || s.url || null,
    })).filter(s => s.name && s.url);
    return results;
  }

  // Format 2 & 3: Object with results
  const songs = data?.data?.results || data?.results || data?.songs || [];
  results = songs.map(s => {
    let url = null;
    if (Array.isArray(s.downloadUrl)) {
      const best = s.downloadUrl.find(d => d.quality === "320kbps")
                || s.downloadUrl.find(d => d.quality === "160kbps")
                || s.downloadUrl[s.downloadUrl.length - 1];
      url = best?.url || null;
    } else if (Array.isArray(s.download_url)) {
      const best = s.download_url.find(d => d.quality === "320kbps")
                || s.download_url[s.download_url.length - 1];
      url = best?.link || best?.url || null;
    } else {
      url = s.downloadUrl || s.url || s.media_url || null;
    }
    return {
      name: s.name || s.song || s.title || "",
      artist: Array.isArray(s.artists?.primary)
                ? s.artists.primary.map(a => a.name).join(", ")
                : s.primaryArtists || s.singers || s.artist || "",
      album: s.album?.name || s.album || "",
      url,
    };
  }).filter(s => s.name && s.url);

  return results;
}

/* ─────────────────────────────────────────────
   API HANDLER — Multi-source Saavn
───────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { title, artist, album } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });

  console.log(`\n🎵 Saavn: "${title}" — ${artist || "?"} | Album: "${album || "?"}"`);

  // ✅ Smart queries (3 strategies)
  const searchQueries = [
    `${title} ${artist || ""}`.trim(),
    `${artist || ""} ${title}`.trim(),
    title.trim(),
  ];

  const uniqueQueries = [...new Set(searchQueries)].filter(q => q);

  // ✅ More Saavn APIs (5 sources for better coverage)
  const APIS = [
    {
      name: "saavn.dev",
      build: (q) => `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`,
    },
    {
      name: "jiosaavn-privatecvc2",
      build: (q) => `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`,
    },
    {
      name: "saavn-api-with-cors",
      build: (q) => `https://saavn-api-with-cors.vercel.app/search/songs?query=${encodeURIComponent(q)}&limit=15`,
    },
    {
      name: "saavnapi-nine",
      build: (q) => `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(q)}`,
    },
    {
      name: "jiosaavn-api-ts",
      build: (q) => `https://jiosaavn-api-ts.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=15`,
    },
  ];

  let bestOverallMatch = null;
  let bestOverallScore = -1;

  // ✅ Total time budget: ~6 seconds max
  const startTime = Date.now();
  const MAX_TIME = 6000;

  for (const query of uniqueQueries) {
    if (Date.now() - startTime > MAX_TIME) {
      console.log("   ⏱️ Time budget exceeded, stopping");
      break;
    }

    console.log(`\n   🔍 Query: "${query}"`);

    for (const api of APIS) {
      if (Date.now() - startTime > MAX_TIME) break;

      const apiUrl = api.build(query);
      console.log(`   API: ${api.name}`);

      const data = await tryApi(apiUrl, 1);  // ✅ Only 1 retry (was 2) for speed
      if (!data) continue;

      const results = extractSongs(data);
      console.log(`   Results: ${results.length}`);
      if (!results.length) continue;

      const match = bestMatch(results, title, artist, album);
      const minScore = title.length <= 5 ? 35 : 50;

      if (match && match.sc >= minScore) {
        if (match.sc > bestOverallScore) {
          bestOverallMatch = match;
          bestOverallScore = match.sc;
        }

        // ✅ Excellent match? Return immediately
        if (match.sc >= 100) {
          const audioUrl = match.r.url.replace(/^http:\/\//i, "https://");
          console.log(`   ✅ EXCELLENT MATCH: "${match.r.name}" score=${match.sc} (${api.name})`);
          return res.json({
            success: true,
            url: audioUrl,
            matched: match.r.name,
            artist: match.r.artist,
            score: match.sc,
          });
        }
      } else {
        console.log(`   ❌ Score too low: ${match?.sc || 0}`);
      }

      // Small delay between API calls
      await sleep(100);
    }

    // If we have a good match, no need for more queries
    if (bestOverallScore >= 70) break;
    await sleep(150);
  }

  // ✅ Return best match found
  if (bestOverallMatch && bestOverallScore >= (title.length <= 5 ? 35 : 50)) {
    const audioUrl = bestOverallMatch.r.url.replace(/^http:\/\//i, "https://");
    console.log(`   ✅ BEST MATCH: "${bestOverallMatch.r.name}" score=${bestOverallScore}`);
    return res.json({
      success: true,
      url: audioUrl,
      matched: bestOverallMatch.r.name,
      artist: bestOverallMatch.r.artist,
      score: bestOverallScore,
    });
  }

  console.log(`   ❌ Not found after ${(Date.now() - startTime)}ms`);
  return res.json({ success: false, url: null, reason: "Not found on Saavn" });
};