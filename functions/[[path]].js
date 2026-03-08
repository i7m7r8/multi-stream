// MultiStream Stremio Addon — Cloudflare Pages Functions
// File: functions/[[path]].js
// Deploy: GitHub repo → Cloudflare Pages (free, unlimited deploys)

const TMDB_KEY = "4ef0d7355d9ffb5151e987764708ce96";
const SELF_URL = "https://YOUR-SITE.pages.dev"; // update after first deploy

const manifest = {
  id: "community.multistream.v14",
  version: "14.11.0",
  name: "MultiStream",
  description: "Bollywood, Hollywood, TV Shows & Anime",
  logo: "https://i.imgur.com/uwDqNDd.png",
  catalogs: [
    { type: "movie",  id: "ms_hollywood",  name: "🎬 Hollywood",         extra: [{ name: "search" }, { name: "skip" }] },
    { type: "movie",  id: "ms_bollywood",  name: "🇮🇳 Bollywood & Hindi", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "ms_tvshows",    name: "📺 TV Shows",           extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "ms_anime",      name: "🎌 Anime",              extra: [{ name: "search" }, { name: "skip" }] }
  ],
  resources: ["catalog", "stream", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["ms_", "tt"],
  behaviorHints: { adult: true, p2p: true }
};

const TRACKERS = [
  "tracker:udp://open.demonii.com:1337/announce",
  "tracker:udp://tracker.openbittorrent.com:80",
  "tracker:udp://tracker.coppersurfer.tk:6969",
  "tracker:udp://tracker.opentrackr.org:1337/announce",
  "tracker:udp://tracker.leechers-paradise.org:6969",
  "tracker:http://nyaa.tracker.wf:7777/announce",
  "tracker:udp://exodus.desync.com:6969/announce",
  "tracker:udp://tracker.torrent.eu.org:451/announce"
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json"
};

// ── Helpers ───────────────────────────────────────────────────
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const p of str.split("&")) {
    const i = p.indexOf("=");
    if (i > 0) out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
  }
  return out;
}

function clean(name) {
  let t = name || "";
  t = t.replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ");
  t = t.replace(/\s*[|]\s*.*/g, "");
  t = t.replace(/S\d+E\d+.*/i, " ");
  t = t.replace(/\b(19|20)\d{2}\b.*/, "");
  t = t.replace(/\b(2160p|1080p|720p|480p|4K|UHD|HDR|BluRay|BRRip|WEBRip|WEB-DL|WEB|HDTS|HDCAM|CAMRip|HDTC|DVDSCR|HDTV|DVDRip|x264|x265|HEVC|AAC|DDP|DD5|AC3|ESub|EZTV|YIFY|YTS|Atmos|SDR|10bit|REMUX|REPACK|PROPER|EXTENDED|UNRATED|COMPLETE|SEASON|EPISODE|MULTI|BLURAY|LPCM)\b.*/gi, "");
  t = t.replace(/[-._]+/g, " ").replace(/\s+/g, " ").replace(/[\s,;:\-]+$/, "");
  return t.trim();
}

function quality(name) {
  if (/2160p|4K|UHD/i.test(name)) return "4K";
  if (/1080p/i.test(name)) return "1080p";
  if (/720p/i.test(name)) return "720p";
  if (/480p/i.test(name)) return "480p";
  return "SD";
}

function sizeStr(b) {
  const n = parseInt(b) || 0;
  if (n > 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n > 1048576) return (n / 1048576).toFixed(0) + " MB";
  return n + " B";
}

// ── Fetch with rotating UA ────────────────────────────────────
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/17.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
];

async function fetchJson(url) {
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const r = await fetch(url, {
    headers: {
      "User-Agent": ua,
      "Accept": "application/json, */*",
      "Referer": "https://www.google.com/"
    },
    cf: { cacheTtl: 30 }
  });
  return r.json();
}

// ── torrents-csv.com search (works from Cloudflare!) ─────────
async function csvSearch(q, size = 20) {
  try {
    const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(q)}&size=${size}`;
    const r = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": UAS[0] },
      cf: { cacheTtl: 60 }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.torrents || []).map(t => ({
      info_hash: t.infohash || "",
      name: t.name || "",
      seeders: String(t.seeders || 0),
      size: String(t.size_bytes || 0),
      id: String(t.id || "1"),
      category: "0"
    })).filter(t => t.info_hash && parseInt(t.seeders) > 0);
  } catch(e) { return []; }
}

// ── apibay search ─────────────────────────────────────────────
async function tpbSearch(q, cat) {
  try {
    const t1 = `https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=${cat}`;
    const t2 = `https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=0`;
    // Try apibay directly first, fallback to mirror sites
    const [r1, r2] = await Promise.allSettled([
      fetchWithFallback(t1),
      fetchWithFallback(t2)
    ]);
    const seen = new Set();
    const merged = [];
    for (const r of [r1, r2]) {
      const arr = r.status === "fulfilled" ? (Array.isArray(r.value) ? r.value : []) : [];
      for (const t of arr) {
        if (!t.info_hash || t.id === "0" || seen.has(t.info_hash)) continue;
        seen.add(t.info_hash);
        merged.push(t);
      }
    }
    merged.sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders));
    return merged;
  } catch(e) { return []; }
}

// ── Nyaa RSS ──────────────────────────────────────────────────
async function nyaaSearch(q) {
  const ua = UAS[0];
  const r = await fetch(`https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=1_2&f=0`, {
    headers: { "User-Agent": ua }
  });
  const text = await r.text();
  const items = [];
  for (const block of text.split("<item>").slice(1)) {
    const title   = block.match(/<title>(.*?)<\/title>/s)?.[1]?.trim() || "";
    const hash    = block.match(/<nyaa:infoHash>([a-fA-F0-9]{40})<\/nyaa:infoHash>/i)?.[1]?.toLowerCase() || "";
    const seeders = block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || "0";
    const size    = block.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] || "";
    if (title && hash && parseInt(seeders) > 0) items.push({ title, hash, seeders, size });
    if (items.length >= 20) break;
  }
  return items;
}

// ── TMDB ──────────────────────────────────────────────────────
async function tmdbSearch(title, type) {
  try {
    const t = type === "series" ? "tv" : "movie";
    const r = await fetchJson(`https://api.themoviedb.org/3/search/${t}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`);
    const res = r?.results?.[0];
    if (!res) return null;
    let imdbId = null;
    try {
      const ext = await fetchJson(`https://api.themoviedb.org/3/${t}/${res.id}/external_ids?api_key=${TMDB_KEY}`);
      imdbId = ext?.imdb_id || null;
    } catch(e) {}
    return {
      imdbId,
      name: res.title || res.name || title,
      poster: res.poster_path ? `https://image.tmdb.org/t/p/w300${res.poster_path}` : null,
      bg: res.backdrop_path ? `https://image.tmdb.org/t/p/w780${res.backdrop_path}` : null,
      year: (res.release_date || res.first_air_date || "").slice(0, 4),
      description: res.overview || ""
    };
  } catch(e) { return null; }
}

async function tmdbFindByImdb(imdbId) {
  try {
    const r = await fetchJson(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`);
    const found = r?.movie_results?.[0] || r?.tv_results?.[0];
    if (!found) return null;
    return {
      name: found.title || found.name || imdbId,
      poster: found.poster_path ? `https://image.tmdb.org/t/p/w300${found.poster_path}` : null,
      bg: found.backdrop_path ? `https://image.tmdb.org/t/p/w780${found.backdrop_path}` : null,
      year: (found.release_date || found.first_air_date || "").slice(0, 4),
      description: found.overview || ""
    };
  } catch(e) { return null; }
}

// ── Build streams ─────────────────────────────────────────────
function buildStreams(results, refHash) {
  const seen = new Set(refHash ? [refHash] : []);
  const packs = [], singles = [];
  const MAX = 10 * 1024 * 1024 * 1024;
  const sorted = [...results].sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders));
  for (const t of sorted) {
    if (!t.info_hash || parseInt(t.seeders) < 1) continue;
    if (parseInt(t.size) > MAX) continue;
    const h = t.info_hash.toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    const q  = quality(t.name);
    const sz = sizeStr(t.size);
    const sd = t.seeders;
    const short = t.name.length > 60 ? t.name.slice(0, 57) + "..." : t.name;
    const epMatch = t.name.match(/S(\d+)(?:E(\d+))?/i);
    const isPack  = epMatch && !epMatch[2];
    const stream  = {
      name: `MultiStream\n${q}`,
      title: `${short}\n👤 ${sd} 💾 ${sz}`,
      infoHash: h,
      sources: TRACKERS,
      behaviorHints: { notWebReady: false }
    };
    if (isPack) packs.push(stream); else singles.push(stream);
    if (singles.length + packs.length >= 8) break;
  }
  return [...singles, ...packs].slice(0, 8);
}

// ── MAIN ──────────────────────────────────────────────────────
export async function onRequest({ request }) {
  const url  = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  // DEBUG
  if (path === "/debug") {
    try {
      const results = await csvSearch("Mr Robot S01E01");
      // Also test TMDB
      const tmdbInfo = await tmdbFindByImdb("tt4158110");
      // Test buildStreams
      const streams = buildStreams(results, "");
      return jsonResp({ 
        csv_count: results.length, 
        first: results[0] || null,
        tmdb_name: tmdbInfo?.name || "FAILED",
        streams_count: streams.length,
        first_stream: streams[0] || null
      });
    } catch(e) {
      return jsonResp({ error: String(e) });
    }
  }

  // MANIFEST
  if (path === "/" || path === "/manifest.json") return jsonResp(manifest);

  // CATALOG
  const cm = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
  if (cm) {
    const [, type, id, extraStr] = cm;
    const extra  = parseExtra(extraStr);
    const search = extra.search || "";
    try {
      if (id === "ms_anime") {
        const items = await nyaaSearch(search || "anime 1080p");
        const seen = new Set();
        const metas = [];
        for (const item of items) {
          const name = clean(item.title.replace(/^\[.*?\]\s*/, ""));
          if (!name || seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());
          metas.push({
            id: `ms_${item.hash}_${encodeURIComponent(name).replace(/%/g,"_")}`,
            type: "series", name,
            poster: `https://via.placeholder.com/300x450/0f0f1a/e879f9?text=${encodeURIComponent(name.slice(0,15))}`,
            description: `🎌 ${quality(item.title)} | 🌱 ${item.seeders} seeds | ${item.size}`,
            genres: ["Anime"]
          });
        }
        return jsonResp({ metas });
      }

      const catMap   = { ms_hollywood: "207", ms_bollywood: "200", ms_tvshows: "205" };
      const queryMap = { ms_hollywood: "movie", ms_bollywood: "hindi", ms_tvshows: "tv show" };
      const q   = search || queryMap[id] || "movie";
      const cat = catMap[id] || "0";
      const results = await tpbSearch(q, cat);
      const seen = new Set();
      const metas = [];
      for (const t of results) {
        if (!t.info_hash || parseInt(t.seeders) < 1) continue;
        const name = clean(t.name);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        let metaId = `ms_${t.info_hash.toLowerCase()}_${encodeURIComponent(name).replace(/%/g,"_")}`;
        let poster = `https://via.placeholder.com/300x450/0f0f1a/818cf8?text=${encodeURIComponent(name.slice(0,15))}`;
        let desc = `${quality(t.name)} | 🌱 ${t.seeders} seeds | 💾 ${sizeStr(t.size)}`;
        let yr = (t.name.match(/\b(19|20)\d{2}\b/) || [])[0] || "";
        try {
          const tmdb = await tmdbSearch(name, type);
          if (tmdb) {
            if (tmdb.imdbId) metaId = tmdb.imdbId;
            if (tmdb.poster) poster = tmdb.poster;
            if (tmdb.description) desc = tmdb.description;
            if (tmdb.year) yr = tmdb.year;
          }
        } catch(e) {}
        metas.push({ id: metaId, type, name, poster, description: desc, year: yr, genres: [] });
        if (metas.length >= 20) break;
      }
      return jsonResp({ metas });
    } catch(e) { return jsonResp({ metas: [] }); }
  }

  // META
  const mm = path.match(/^\/meta\/([^/]+)\/([^/]+?)\.json$/);
  if (mm) {
    const [, type, id] = mm;
    if (id.startsWith("tt")) {
      const info = await tmdbFindByImdb(id);
      if (info) return jsonResp({ meta: {
        id, type, name: info.name,
        poster: info.poster,
        background: info.bg,
        description: info.description, year: info.year, genres: []
      }});
    }
    const parts = id.replace("ms_", "").split("_");
    const name = parts.length > 1
      ? decodeURIComponent(parts.slice(1).join("_").replace(/_/g, "%"))
      : parts[0].slice(0, 12);
    const tmdb = await tmdbSearch(name, type).catch(() => null);
    return jsonResp({ meta: {
      id, type, name: tmdb?.name || name,
      poster: tmdb?.poster,
      background: tmdb?.bg,
      description: tmdb?.description || name, year: tmdb?.year || "", genres: []
    }});
  }

  // STREAM
  const sm = path.match(/^\/stream\/([^/]+)\/([^/]+?)\.json$/);
  if (sm) {
    const [, type, rawId] = sm;
    const decoded = decodeURIComponent(rawId);
    const ttMatch = decoded.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
    const isMsId  = decoded.startsWith("ms_");
    let titleQuery = "", season = null, episode = null, refHash = "";

    if (ttMatch) {
      season  = ttMatch[2] ? parseInt(ttMatch[2]) : null;
      episode = ttMatch[3] ? parseInt(ttMatch[3]) : null;
      const info = await tmdbFindByImdb(ttMatch[1]).catch(() => null);
      titleQuery = info?.name || "";
    } else if (isMsId) {
      const parts = decoded.replace("ms_", "").split("_");
      refHash = parts[0];
      titleQuery = parts.length > 1
        ? decodeURIComponent(parts.slice(1).join("_").replace(/_/g, "%"))
        : "";
    }

    if (!titleQuery) return jsonResp({ streams: [{
      name: "MultiStream", title: "⚡ Play",
      infoHash: refHash || "0000000000000000000000000000000000000000",
      sources: TRACKERS, behaviorHints: { notWebReady: false }
    }]});

    const cat = type === "movie" ? "207" : "205";
    let results = [];

    if (season !== null && episode !== null) {
      const epQ     = `${titleQuery} S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`;
      const seasonQ = `${titleQuery} S${String(season).padStart(2,"0")}`;
      const [r1, r2] = await Promise.allSettled([tpbSearch(epQ, cat), tpbSearch(seasonQ, cat)]);
      const seen = new Set();
      for (const r of [r1, r2]) {
        if (r.status !== "fulfilled") continue;
        for (const t of r.value) {
          if (!t.info_hash || seen.has(t.info_hash.toLowerCase())) continue;
          const titleWords = titleQuery.toLowerCase().split(" ").filter(w => w.length > 2);
          const tname = t.name.toLowerCase();
          const matchCount = titleWords.filter(w => tname.includes(w)).length;
          if (matchCount < Math.ceil(titleWords.length * 0.6)) continue;
          seen.add(t.info_hash.toLowerCase());
          results.push(t);
        }
      }
    } else {
      results = await tpbSearch(titleQuery, cat).catch(() => []);
    }

    const streams = buildStreams(results, refHash);
    if (!streams.length) return jsonResp({ streams: [{
      name: "MultiStream", title: `${titleQuery}\n⚡ Play [${results.length} found]`,
      infoHash: refHash || "0000000000000000000000000000000000000000",
      sources: TRACKERS, behaviorHints: { notWebReady: false }
    }]});
    return jsonResp({ streams });
  }

  return jsonResp({ error: "not found" }, 404);
}
