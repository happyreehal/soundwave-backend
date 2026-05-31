const fetch = require("node-fetch");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });

  const NODES = [
    "https://discoveryprovider.audius.co",
    "https://discoveryprovider2.audius.co",
    "https://discoveryprovider3.audius.co",
  ];

  function clean(s = "") {
    return s.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\b(official|audio|video|lyrics|feat|ft|featuring|hd|remix|cover|live|version|acoustic)\b/g, "")
      .replace(/\s+/g, " ").trim();
  }

  const tT = clean(title);
  const tA = clean(artist || "");

  for (const node of NODES) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 6000);

      const r = await fetch(
        `${node}/v1/tracks/search?query=${encodeURIComponent(title + " " + (artist || ""))}&limit=10&app_name=SoundWavePro`,
        { signal: controller.signal }
      );
      if (!r.ok) continue;

      const data = await r.json();
      const tracks = data?.data || [];
      if (!tracks.length) continue;

      const scored = tracks.map(t => {
        const iT = clean(t.title || "");
        const iA = clean(t.user?.name || "");
        let score = 0;
        if (iT === tT)            score += 100;
        else if (iT.includes(tT)) score += 70;
        else if (tT.includes(iT)) score += 50;
        if (iA === tA)            score += 50;
        else if (iA.includes(tA)) score += 35;
        else if (tA.includes(iA)) score += 25;
        return { t, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 50) continue;

      return res.json({
        success: true,
        url: `${node}/v1/tracks/${best.t.id}/stream?app_name=SoundWavePro`,
        matched: best.t.title,
      });

    } catch (e) { continue; }
  }

  return res.json({ success: false, url: null, reason: "Not found on Audius" });
};