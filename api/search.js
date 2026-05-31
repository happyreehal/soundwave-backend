const fetch = require("node-fetch");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`;
    const resp = await fetch(url);
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

    res.json({ success: true, results });

  } catch (e) {
    res.json({ success: false, results: [], error: e.message });
  }
};