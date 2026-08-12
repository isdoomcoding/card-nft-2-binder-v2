#!/usr/bin/env node
/**
 * minimal-server.js — Production for 100–200 users
 * ==========================================================================
 * Serves MULTIPLE collections from one process (see COLLECTIONS below).
 *
 * Collection data:
 *   a) Set SERVER_HELIUS_KEY in env → live shared mode (cached ~90s).
 *   b) No key → static snapshot from each collection's rawSnapshot file.
 *
 * Routes are namespaced: /api/<slug>/{collection,wallet,listings,unminted,trade/*}
 * Legacy un-namespaced routes (/collection, /wallet, /listings/card_nft_2,
 * /trade/*) are aliased to card_nft_2 so the original binder keeps working.
 *
 * Listings:
 *   Magic Eden listings are fetched server-side (all pages), merged and
 *   sorted by price, cached 30s so one upstream sweep serves many users.
 *
 * Run:
 *   SERVER_HELIUS_KEY=... node minimal-server.js
 */

import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createIntentStore, issueNonce, verifySignIn, resolveToken, loadSessionsFromDisk, SOL_ADDR } from './trade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === Auto-load .env (no dependency) so the live collection key works out of the box ===
// Reads ./.env if present and fills process.env without overwriting vars already set
// (e.g. by systemd/pm2). Drop a .env next to this file with HELIUS_RPC_KEY=... to go live.
(() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] in process.env) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore — fall back to static snapshot */ }
})();

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// === Optional Helius key for live shared collection ===
const HELIUS_KEY = process.env.SERVER_HELIUS_KEY || process.env.HELIUS_RPC_KEY || '';
const HELIUS_RPC = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';  // shared secret Helius sends as Authorization

const COLLECTION_TTL = 90_000;     // 90s "fresh"; stale entries are still served (SWR)
const NEWEST_POLL_MS = 300_000;    // 5min safety-net poll (the Helius webhook drives realtime now)
const FULL_RECONCILE_MS = 3_600_000; // 1h: full collection reconcile (catches burns / edits)
const UNMINTED_TTL = 3_600_000;    // safety recompute if reconcile/webhook somehow missed a mint

// === Collections served by this process ===
// card_nft_2 keeps its original (un-suffixed) data filenames so nothing migrates.
const COLLECTIONS = {
  card_nft_2: {
    slug: 'card_nft_2',
    label: 'Card NFT 2',
    collectionGroup: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu',
    magicEdenSlug: 'card_nft_2',
    htmlFile: 'card-nft-2-binder.html',
    htmlRoutes: ['/', '/card-nft-2-binder.html'],
    slimSnapshot: 'data/collection-slim.json',
    rawSnapshot: 'data/card-nft-2-collection.json',
    intentsFile: 'data/trade-intents.json',
    unminted: null,
  },
  poncho: {
    slug: 'poncho',
    label: 'Poncho Drifella',
    collectionGroup: 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH',
    magicEdenSlug: 'poncho_drifella',
    htmlFile: 'poncho-binder.html',
    htmlRoutes: ['/poncho', '/poncho-binder.html'],
    slimSnapshot: 'data/poncho-collection-slim.json',
    rawSnapshot: 'data/poncho-collection.json',
    intentsFile: 'data/trade-intents-poncho.json',
    // The full 207-card set's metadata/art is pre-published on mons.link, so cards
    // still sealed in packs (never minted on-chain) can be previewed.
    unminted: {
      setSize: 207,
      figuresUrl: n => `https://assets.mons.link/drops/poncho/json/figures/${n}.json`,
      // Same art as the mons.link figure JSON, but cropped to the card edges
      // instead of letterboxed into a padded square — better for tiles.
      imageUrl: n => `https://cdn.lil.org/nft/poncho_drifella/items/clean/${n}.webp`,
      figuresCache: 'data/poncho-figures.json',
      stateFile: 'data/poncho-unminted-state.json',
    },
  },
};

// === Listings cache (keys are namespaced per collection) ===
const listingsCache = new Map();
const LISTINGS_TTL = 30_000;
const WALLET_TTL = 60_000;          // 60s per-address holdings cache

function createCollectionState(cfg) {
  return {
    cfg,
    collectionCache: null,   // { data, ts, body:Buffer, gzip:Buffer }
    refreshing: false,       // guards background revalidation
    walletCache: new Map(),  // address -> { mints:[], ts }
    _whDebounce: null,       // webhook burst coalescing
    trade: createIntentStore(cfg.intentsFile),
    // unminted state (only used when cfg.unminted is set)
    un: cfg.unminted ? {
      minted: new Set(),     // card numbers ever seen on-chain (incl. burnt)
      figures: new Map(),    // number -> slim ghost asset (from pre-published metadata)
      cache: null,           // { body:Buffer, gzip:Buffer, ts }
      computing: false,
    } : null,
  };
}

const STATES = Object.fromEntries(Object.keys(COLLECTIONS).map(k => [k, createCollectionState(COLLECTIONS[k])]));

// Page routes -> collection slug, so a page load can be attributed to a collection.
const PAGE_ROUTES = new Map();
for (const st of Object.values(STATES))
  for (const r of st.cfg.htmlRoutes) PAGE_ROUTES.set(r, st.cfg.slug);

// === Traffic stats (in-memory, resets on restart — a deploy/pm2 restart resets the
// "today" window early; not persisted to disk, this is meant as a rough signal, not
// a source of truth). Also logs whether the funnel forwards a real client IP at all. ===
const STATS_SECRET = process.env.STATS_SECRET || WEBHOOK_SECRET;
let stats = freshStats();
function freshStats() {
  return { since: Date.now(), pageLoads: 0, walletLookupsFresh: 0, walletLookupsCached: 0, ips: new Set(), pageLoadsBySlug: {} };
}
function trackHit(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  stats.ips.add(ip);
}
function statsSnapshot() {
  const collections = {};
  for (const st of Object.values(STATES)) {
    collections[st.cfg.slug] = {
      pageLoads: stats.pageLoadsBySlug[st.cfg.slug] || 0,
      uniqueAddressesLookedUp: st.walletCache.size,
      assets: st.collectionCache?.data.length || 0,
      listed: listingsCache.get(`merged:${st.cfg.slug}`)?.data.length || 0,
    };
  }
  return {
    since: new Date(stats.since).toISOString(),
    pageLoads: stats.pageLoads,
    walletLookupsFresh: stats.walletLookupsFresh,
    walletLookupsCached: stats.walletLookupsCached,
    uniqueIPsSeen: stats.ips.size,
    sampleIP: stats.ips.size ? [...stats.ips][0] : null, // sanity check: is this a real client IP or always the funnel's?
    collections,
  };
}
setInterval(() => {
  console.log('[stats]', JSON.stringify(statsSnapshot()));
  stats = freshStats();
}, 24 * 60 * 60 * 1000);

function isFresh(entry, ttl) { return !!entry && (Date.now() - (entry.ts || 0) < ttl); }

function clientAcceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }

// gzip-aware writer for any buffer (skips gzip for tiny payloads)
function sendBuffer(req, res, status, buf, contentType, extraHeaders) {
  const headers = { 'content-type': contentType, 'access-control-allow-origin': '*', ...extraHeaders };
  if (clientAcceptsGzip(req) && buf.length > 1024) {
    headers['content-encoding'] = 'gzip';
    headers['vary'] = 'accept-encoding';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function writeJson(res, status, data, extraHeaders) {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req, cap = 1_048_576) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { if (body.length < cap) body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function readRawBody(req, cap = 1_048_576) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { if (body.length < cap) body += c; });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function bearerAddress(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  return resolveToken(auth.slice(7));
}

// === Static file cache: read + gzip + ETag once per process lifetime, not per request ===
// A fresh process (every deploy restarts) means a fresh cache — no manual invalidation needed.
const staticFileCache = new Map(); // path -> { raw, gzip, etag, contentType, cacheControl }
const COMPRESSIBLE_TYPE = /^(text\/|application\/json)/;

function getStaticFile(key, diskPath, contentType, cacheControl) {
  let entry = staticFileCache.get(key);
  if (entry) return entry;
  const raw = fs.readFileSync(path.join(__dirname, diskPath));
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"';
  // Images are already compressed — gzipping them wastes CPU for no size benefit.
  const gzip = COMPRESSIBLE_TYPE.test(contentType) && raw.length > 1024 ? zlib.gzipSync(raw) : null;
  entry = { raw, gzip, etag, contentType, cacheControl };
  staticFileCache.set(key, entry);
  return entry;
}

function serveStatic(req, res, entry) {
  const headers = {
    'content-type': entry.contentType,
    'access-control-allow-origin': '*',
    'cache-control': entry.cacheControl,
    'etag': entry.etag,
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const useGzip = !!entry.gzip && clientAcceptsGzip(req);
  if (useGzip) { headers['content-encoding'] = 'gzip'; headers['vary'] = 'accept-encoding'; }
  res.writeHead(200, headers);
  res.end(useGzip ? entry.gzip : entry.raw);
}

// Keep only the fields the binder UI actually reads → ~3x smaller payload.
function slimAsset(a) {
  const md = a?.content?.metadata || {};
  const image = a?.content?.links?.image
    || (a?.content?.files || []).find(f => f?.mime && String(f.mime).startsWith('image'))?.uri
    || null;
  return { id: a?.id, content: { metadata: { name: md.name, attributes: md.attributes || [] }, links: { image } } };
}

// Card number of an asset, or null if it isn't a card / card receipt.
// Pack numbers are an INDEPENDENT numbering space — only `card N` and
// `receipt · card N` names count toward the minted set.
function cardNumberOf(a) {
  const md = a?.content?.metadata || {};
  const t = (md.attributes || []).find(x => String(x?.trait_type).toLowerCase() === 'type');
  const tv = String(t?.value || '').toLowerCase();
  if (tv !== 'card' && tv !== 'card receipt') return null;
  const m = String(md.name || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

function buildCollectionCache(data) {
  const body = Buffer.from(JSON.stringify(data));
  return { data, ts: Date.now(), body, gzip: zlib.gzipSync(body) };
}

function setCollectionCache(st, data) {
  st.collectionCache = buildCollectionCache(data);
  st.trade.setCollectionData(data);
  return st.collectionCache;
}

function dataPath(rel) { return path.join(__dirname, rel); }

// === Helius fetch (slimmed) ===
// Also tallies minted card numbers (burnt-INCLUSIVE) for the unminted view:
// a burnt `card N` was still minted once — its number is not "in a pack".
async function fetchCollectionLive(st) {
  const all = [];
  const seen = new Set();
  const minted = st.un ? new Set() : null;
  let page = 1;
  while (page <= 25) {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'live', method: 'getAssetsByGroup',
      params: { groupKey: 'collection', groupValue: st.cfg.collectionGroup, page, limit: 500,
                sortBy: { sortBy: 'created', sortDirection: 'desc' } }
    });
    const r = await fetch(HELIUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    const items = j.result?.items || [];
    for (const it of items) {
      if (minted) { const n = cardNumberOf(it); if (n != null) minted.add(n); }
      if (it?.id && !it.burnt && !seen.has(it.id)) { seen.add(it.id); all.push(slimAsset(it)); }
    }
    if (items.length < 500) break;
    page++;
  }
  // Array is newest-first (created desc). Stamp a mint-rank so the client can sort
  // by true creation order: higher m = more recently minted.
  const n = all.length;
  for (let i = 0; i < n; i++) all[i].m = n - 1 - i;
  return { assets: all, minted };
}

// Which mints from THIS collection a given wallet currently holds.
async function fetchWalletHoldings(st, addr) {
  const mints = [];
  let page = 1;
  while (page <= 20) {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'wallet', method: 'getAssetsByOwner',
      params: { ownerAddress: addr, page, limit: 1000, displayOptions: { showUnverifiedCollections: false } }
    });
    const r = await fetch(HELIUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    const items = j.result?.items || [];
    for (const it of items) {
      const inColl = (it?.grouping || []).some(g => g?.group_key === 'collection' && g?.group_value === st.cfg.collectionGroup);
      if (inColl && it?.id && !it.burnt) mints.push(it.id);
    }
    if (items.length < 1000) break;
    page++;
  }
  return mints;
}

// === Listings: ME (fetched server-side, all pages, cached 30s) ===
// listingAggMode=true merges in M2 (escrow-less) listings — without it the API
// silently returns only legacy-escrow listings (~208 vs the ~460 the ME site shows).
async function fetchMEListings(st) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${st.cfg.magicEdenSlug}/listings?offset=${offset}&limit=100&listingAggMode=true`, {
      headers: { accept: 'application/json', 'user-agent': 'binder/1.0' },
    });
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const l of data) {
      const mint = l.tokenMint || l.mint;
      if (mint) out.push({ mint, price: Number(l.price || 0), seller: l.seller || '', marketplace: 'magic-eden' });
    }
    // Do NOT stop early on a short page — Magic Eden can return a page with
    // fewer than `limit` results in the middle of the sequence (not just on
    // the last page), so only a truly empty page means "no more results".
  }
  return out;
}

// Refresh the collection cache in the background (stale-while-revalidate).
async function revalidateCollection(st) {
  if (st.refreshing || !HELIUS_RPC) return;
  st.refreshing = true;
  try {
    const { assets, minted } = await fetchCollectionLive(st);
    if (assets.length) {
      setCollectionCache(st, assets);
      try { fs.mkdirSync(path.dirname(dataPath(st.cfg.slimSnapshot)), { recursive: true }); fs.writeFileSync(dataPath(st.cfg.slimSnapshot), st.collectionCache.body); } catch {}
      if (st.un && minted) { st.un.minted = minted; computeUnminted(st); }
    }
  } catch { /* keep serving the previous cache */ }
  finally { st.refreshing = false; }
}

// Cheap poll: fetch only the most-recently-created assets (1 call) and merge any
// new mints into the cache. ~10 credits/poll vs ~190 for a full refresh.
async function fetchNewestAssets(st, limit = 100) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'newest', method: 'getAssetsByGroup',
    params: {
      groupKey: 'collection', groupValue: st.cfg.collectionGroup,
      page: 1, limit,
      sortBy: { sortBy: 'created', sortDirection: 'desc' }
    }
  });
  const r = await fetch(HELIUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return (j.result?.items || []).filter(it => it?.id && !it.burnt).map(slimAsset);
}

async function revalidateNewest(st) {
  if (!HELIUS_RPC || st.refreshing) return;          // don't overlap a full reconcile
  if (!st.collectionCache) return revalidateCollection(st); // cold start -> do a full fetch
  try {
    const newest = await fetchNewestAssets(st, 100);
    const have = new Set(st.collectionCache.data.map(a => a.id));
    const fresh = newest.filter(a => a.id && !have.has(a.id));
    if (fresh.length) {
      let maxM = 0;
      for (const a of st.collectionCache.data) if (typeof a.m === 'number' && a.m > maxM) maxM = a.m;
      fresh.forEach((a, i) => { a.m = maxM + fresh.length - i; }); // fresh is newest-first -> newest gets the top rank
      const data = [...fresh, ...st.collectionCache.data];
      setCollectionCache(st, data);
      try { fs.writeFileSync(dataPath(st.cfg.slimSnapshot), st.collectionCache.body); } catch {}
      console.log(`[newest:${st.cfg.slug}] merged +${fresh.length} new asset(s) -> ${data.length}`);
      if (st.un) {
        let changed = false;
        for (const a of fresh) { const n = cardNumberOf(a); if (n != null && !st.un.minted.has(n)) { st.un.minted.add(n); changed = true; } }
        if (changed) computeUnminted(st);
      }
    } else {
      st.collectionCache.ts = Date.now();            // keep cache "fresh" so SWR won't force a full refetch
    }
  } catch { /* keep serving the previous cache */ }
}

// Webhook hits can arrive in bursts (a mint tx touches several watched accounts);
// coalesce them into one cheap newest-poll every few seconds.
function scheduleNewestPoll(st) {
  if (st._whDebounce) return;
  st._whDebounce = setTimeout(() => { st._whDebounce = null; revalidateNewest(st); }, 3000);
}

// On startup, warm instantly from the slim disk snapshot (marked stale so it revalidates).
function warmFromDisk(st) {
  try {
    if (fs.existsSync(dataPath(st.cfg.slimSnapshot))) {
      const data = JSON.parse(fs.readFileSync(dataPath(st.cfg.slimSnapshot), 'utf8'));
      if (Array.isArray(data) && data.length) { setCollectionCache(st, data); st.collectionCache.ts = 0; }
    }
  } catch {}
}

// ── Unminted cards (pre-published art for numbers never minted on-chain) ────

// Slim ghost asset in the same shape the binder renders. Never depends on the
// figure fetch having succeeded — image URL is constructible from the number.
// Prefer the cropped image (imageUrl) over the figure JSON's own `image` field,
// which points to a version padded/letterboxed into a square canvas.
function ghostAsset(st, n, fig) {
  return {
    id: 'unminted-' + n, unminted: true, number: n,
    content: {
      metadata: { name: fig?.name || `Poncho Drifella #${n}`, attributes: fig?.attributes || [] },
      links: { image: st.cfg.unminted.imageUrl(n) || fig?.image },
    },
  };
}

function buildUnmintedPayload(st) {
  const u = st.un; const cfg = st.cfg.unminted;
  const numbers = [];
  for (let n = 1; n <= cfg.setSize; n++) if (!u.minted.has(n)) numbers.push(n);
  const assets = numbers.map(n => u.figures.get(n) || ghostAsset(st, n, null));
  const payload = { setSize: cfg.setSize, mintedCount: u.minted.size, numbers, assets };
  const body = Buffer.from(JSON.stringify(payload));
  u.cache = { body, gzip: zlib.gzipSync(body), ts: Date.now() };
}

function persistUnminted(st) {
  const cfg = st.cfg.unminted;
  try {
    fs.mkdirSync(path.dirname(dataPath(cfg.stateFile)), { recursive: true });
    fs.writeFileSync(dataPath(cfg.stateFile), JSON.stringify({ mintedNumbers: [...st.un.minted].sort((a, b) => a - b), ts: Date.now() }));
    fs.writeFileSync(dataPath(cfg.figuresCache), JSON.stringify(Object.fromEntries(st.un.figures)));
  } catch {}
}

function warmUnmintedFromDisk(st) {
  const cfg = st.cfg.unminted;
  try {
    if (fs.existsSync(dataPath(cfg.figuresCache))) {
      const obj = JSON.parse(fs.readFileSync(dataPath(cfg.figuresCache), 'utf8'));
      for (const [k, v] of Object.entries(obj)) st.un.figures.set(Number(k), v);
    }
  } catch {}
  try {
    if (fs.existsSync(dataPath(cfg.stateFile))) {
      const s = JSON.parse(fs.readFileSync(dataPath(cfg.stateFile), 'utf8'));
      if (Array.isArray(s?.mintedNumbers) && s.mintedNumbers.length) {
        st.un.minted = new Set(s.mintedNumbers);
        buildUnmintedPayload(st);
        if (st.un.cache) st.un.cache.ts = s.ts || 0;   // stale-marked -> recompute on first serve
      }
    }
  } catch {}
}

// Fetch pre-published figure metadata for unminted numbers (concurrency-limited),
// then (re)build + persist the payload. Figures are immutable art — cached forever.
async function computeUnminted(st) {
  const u = st.un; const cfg = st.cfg.unminted;
  if (!u || u.computing) return;
  u.computing = true;
  try {
    const missing = [];
    for (let n = 1; n <= cfg.setSize; n++) if (!u.minted.has(n) && !u.figures.has(n)) missing.push(n);
    let i = 0;
    async function worker() {
      while (i < missing.length) {
        const n = missing[i++];
        try {
          const r = await fetch(cfg.figuresUrl(n));
          if (!r.ok) continue;                      // retried on next recompute
          const fig = await r.json();
          u.figures.set(n, ghostAsset(st, n, fig));
        } catch { /* retried on next recompute */ }
      }
    }
    await Promise.all(Array.from({ length: 5 }, worker));
    buildUnmintedPayload(st);
    persistUnminted(st);
    console.log(`[unminted:${st.cfg.slug}] ${u.cache ? JSON.parse(u.cache.body).numbers.length : '?'} card(s) still in packs`);
  } catch { /* keep serving previous payload */ }
  finally { u.computing = false; }
}

// === Create server ===

// Legacy (v1) paths → namespaced equivalents; keeps the original binder,
// bookmarks, and the Helius webhook config working untouched.
const LEGACY_ALIASES = {
  '/collection': '/api/card_nft_2/collection',
  '/collection/asset': '/api/card_nft_2/collection/asset',
  '/wallet': '/api/card_nft_2/wallet',
  '/listings/card_nft_2': '/api/card_nft_2/listings',
};

const server = http.createServer(async (req, res) => {
  let p = req.url.split('?')[0];
  if (LEGACY_ALIASES[p]) p = LEGACY_ALIASES[p];
  else if (p.startsWith('/trade/')) p = '/api/card_nft_2' + p;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' });
    return res.end();
  }

  // Helius webhook: a tx touched a mint authority / collection -> pull the new
  // mint(s) in via a cheap newest-poll for the collection(s) referenced in the
  // payload (fallback: all). Token-gated so randoms can't trigger credit spend.
  if (req.method === 'POST' && p === '/helius-webhook') {
    if (!WEBHOOK_SECRET || req.headers['authorization'] !== WEBHOOK_SECRET) {
      req.resume(); res.writeHead(401); return res.end('unauthorized');
    }
    const raw = await readRawBody(req);
    const matched = Object.values(STATES).filter(st => raw.includes(st.cfg.collectionGroup));
    (matched.length ? matched : Object.values(STATES)).forEach(scheduleNewestPoll);
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // 2c. /stats?key=<STATS_SECRET> — quick on-demand traffic snapshot (today so far).
  // Deliberately un-namespaced (one process serves every collection) so the URL is
  // stable across collections; the payload breaks the numbers down per collection.
  if (req.method === 'GET' && p === '/stats') {
    const sp = new URL(req.url, 'http://local').searchParams;
    if (!STATS_SECRET || sp.get('key') !== STATS_SECRET) {
      return writeJson(res, 401, { error: 'unauthorized' });
    }
    return writeJson(res, 200, statsSnapshot());
  }

  // 3. Static files — STRICT allowlist, cached (read+gzip+ETag once per process).
  // Paths are hardcoded — never derived from the URL — so no traversal risk.
  const STATIC = {
    '/tailwind.css': ['tailwind.css', 'text/css; charset=utf-8', 'no-cache'],
    '/img/grain.webp': ['img/grain.webp', 'image/webp', 'public, max-age=31536000, immutable'],
    '/img/glitter.png': ['img/glitter.png', 'image/png', 'public, max-age=31536000, immutable'],
  };
  for (const st of Object.values(STATES))
    for (const route of st.cfg.htmlRoutes)
      STATIC[route] = [st.cfg.htmlFile, 'text/html; charset=utf-8', 'no-cache'];
  const staticEntry = req.method === 'GET' && STATIC[p];
  if (staticEntry) {
    const pageSlug = PAGE_ROUTES.get(p);
    if (pageSlug) {
      trackHit(req);
      stats.pageLoads++;
      stats.pageLoadsBySlug[pageSlug] = (stats.pageLoadsBySlug[pageSlug] || 0) + 1;
    }
    try {
      const file = getStaticFile(p, staticEntry[0], staticEntry[1], staticEntry[2]);
      serveStatic(req, res, file);
      return;
    } catch {
      res.writeHead(500); return res.end('server error');
    }
  }

  // ── Namespaced collection API: /api/<slug>/<route> ────────────────────────
  const api = p.match(/^\/api\/([a-z0-9_]+)\/(.+)$/);
  if (!api) {
    // Anything else → 404. No filesystem path is ever derived from the URL.
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const st = STATES[api[1]];
  if (!st) return writeJson(res, 404, { error: 'Unknown collection.' });
  const route = api[2];

  // 1. collection — slim + gzip, warm cache (SWR). Supports ?limit=&offset= for fast first paint.
  if (req.method === 'GET' && route === 'collection') {
    const sp = new URL(req.url, 'http://local').searchParams;
    const limit = Math.max(0, Math.min(20000, parseInt(sp.get('limit') || '0', 10) || 0));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);

    if (HELIUS_RPC) {
      // Ensure cache exists (cold start fetches once, then it stays warm via SWR).
      if (!st.collectionCache) {
        try {
          const { assets, minted } = await fetchCollectionLive(st);
          setCollectionCache(st, assets);
          try { fs.mkdirSync(path.dirname(dataPath(st.cfg.slimSnapshot)), { recursive: true }); fs.writeFileSync(dataPath(st.cfg.slimSnapshot), st.collectionCache.body); } catch {}
          if (st.un && minted) { st.un.minted = minted; computeUnminted(st); }
        } catch (e) {
          console.error(`[collection:${st.cfg.slug}] fetch failed:`, e);
          return writeJson(res, 503, { error: 'Collection temporarily unavailable. Please try again shortly.' });
        }
      } else if (!isFresh(st.collectionCache, COLLECTION_TTL)) {
        revalidateCollection(st); // refresh in background; serve current copy now
      }
      const xsrc = isFresh(st.collectionCache, COLLECTION_TTL) ? 'server-cache' : 'server-cache-stale';

      // Partial slice → instant first paint
      if (limit > 0) {
        const slice = st.collectionCache.data.slice(offset, offset + limit);
        return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slice)), 'application/json',
          { 'x-source': xsrc, 'x-partial': 'true', 'x-total': String(st.collectionCache.data.length), 'cache-control': 'public, max-age=30' });
      }

      // Full payload → serve precomputed buffers
      const hdr = { 'x-source': xsrc, 'cache-control': 'public, max-age=60' };
      if (clientAcceptsGzip(req)) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-encoding': 'gzip', 'vary': 'accept-encoding', ...hdr });
        return res.end(st.collectionCache.gzip);
      }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...hdr });
      return res.end(st.collectionCache.body);
    }

    // Static snapshot fallback (no key) — slimmed on the way out
    const snapshotPath = dataPath(st.cfg.rawSnapshot);
    if (!fs.existsSync(snapshotPath)) {
      return writeJson(res, 503, { error: 'no snapshot', hint: `Set SERVER_HELIUS_KEY or run snapshot-collection.js ${st.cfg.slug}` });
    }
    try {
      let slim = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).map(slimAsset);
      if (limit > 0) slim = slim.slice(offset, offset + limit);
      return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slim)), 'application/json', { 'x-source': 'static-snapshot' });
    } catch (e) {
      return writeJson(res, 500, { error: 'failed to read snapshot' });
    }
  }

  // 1b. collection/asset?id=<mint> — a single asset by id, from the already-warm
  // cache. Lets a shared card link (?card=) open instantly without waiting on
  // the full collection download.
  if (req.method === 'GET' && route === 'collection/asset') {
    const sp = new URL(req.url, 'http://local').searchParams;
    const id = (sp.get('id') || '').trim();
    if (!id) return writeJson(res, 400, { error: 'Missing id.' });
    let asset;
    if (HELIUS_RPC && st.collectionCache) {
      asset = st.collectionCache.data.find(a => a.id === id);
    } else if (!HELIUS_RPC) {
      const snapshotPath = dataPath(st.cfg.rawSnapshot);
      if (fs.existsSync(snapshotPath)) {
        try {
          const slim = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).map(slimAsset);
          asset = slim.find(a => a.id === id);
        } catch {}
      }
    }
    if (!asset) return writeJson(res, 404, { error: 'Asset not found.' });
    return writeJson(res, 200, asset, { 'cache-control': 'public, max-age=30' });
  }

  // 1c. wallet?address=<addr> — which cards from this collection a wallet holds
  if (req.method === 'GET' && route === 'wallet') {
    if (!HELIUS_RPC) return writeJson(res, 503, { error: 'Wallet lookup needs a server Helius key.' });
    const sp = new URL(req.url, 'http://local').searchParams;
    const addr = (sp.get('address') || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return writeJson(res, 400, { error: 'Invalid Solana address.' });
    trackHit(req);
    const cached = st.walletCache.get(addr);
    if (cached && Date.now() - cached.ts < WALLET_TTL) {
      stats.walletLookupsCached++;
      return writeJson(res, 200, { address: addr, count: cached.mints.length, mints: cached.mints }, { 'x-source': 'wallet-cache' });
    }
    try {
      const mints = await fetchWalletHoldings(st, addr);
      st.walletCache.set(addr, { mints, ts: Date.now() });
      stats.walletLookupsFresh++;
      return writeJson(res, 200, { address: addr, count: mints.length, mints }, { 'x-source': 'helius-live' });
    } catch (e) {
      console.error(`[wallet:${st.cfg.slug}] lookup failed for`, addr, ':', e);
      return writeJson(res, 502, { error: 'Wallet lookup failed. Please try again.' });
    }
  }

  // 2. ME listings — fetch all pages, merge + sort by price, cache as one
  // blob per collection (30s), then slice for pagination. One upstream sweep
  // serves every paginated request instead of proxying page-by-page.
  if (req.method === 'GET' && route === 'listings') {
    // Sanitize input: only offset/limit are honoured, clamped to sane ranges.
    const sp = new URL(req.url, 'http://local').searchParams;
    const offset = Math.max(0, Math.min(100000, parseInt(sp.get('offset') || '0', 10) || 0));
    const limit = Math.max(1, Math.min(500, parseInt(sp.get('limit') || '100', 10) || 100));
    const key = `merged:${st.cfg.slug}`;
    const cached = listingsCache.get(key);
    if (isFresh(cached, LISTINGS_TTL)) {
      const slice = cached.data.slice(offset, offset + limit);
      return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slice)), 'application/json', { 'x-cached': 'true' });
    }
    try {
      const me = await fetchMEListings(st);
      const merged = me.sort((a, b) => a.price - b.price);
      if (merged.length > 0 || !cached) listingsCache.set(key, { data: merged, ts: Date.now() });
      const slice = listingsCache.get(key).data.slice(offset, offset + limit);
      return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slice)), 'application/json',
        { 'x-cached': 'false', 'x-source': `me:${me.length}` });
    } catch (e) {
      console.error(`[listings:${st.cfg.slug}] fetch failed:`, e);
      const c = listingsCache.get(key);
      const slice = c ? c.data.slice(offset, offset + limit) : [];
      return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slice)), 'application/json', { 'x-cached': c ? 'stale' : 'empty' });
    }
  }

  // 2b. unminted — cards never minted on-chain (still sealed in packs), with
  // real art from the pre-published metadata. Precomputed buffer, SWR refresh.
  if (req.method === 'GET' && route === 'unminted') {
    if (!st.un) return writeJson(res, 404, { error: 'No unminted view for this collection.' });
    if (!st.un.cache) {
      if (!st.un.minted.size) return writeJson(res, 503, { error: 'Unminted data not ready yet.' });
      buildUnmintedPayload(st);
    }
    if (!isFresh(st.un.cache, UNMINTED_TTL)) computeUnminted(st);  // refresh in background
    const hdr = { 'cache-control': 'public, max-age=300' };
    if (clientAcceptsGzip(req)) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-encoding': 'gzip', 'vary': 'accept-encoding', ...hdr });
      return res.end(st.un.cache.gzip);
    }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...hdr });
    return res.end(st.un.cache.body);
  }

  // ── Trade matchmaker routes ──────────────────────────────────────────────
  if (route.startsWith('trade/') || route === 'trade') {
    const tr = route.replace(/^trade\/?/, '');

    // GET trade/nonce?address=   → { nonce, message }
    if (req.method === 'GET' && tr === 'nonce') {
      const sp   = new URL(req.url, 'http://local').searchParams;
      const addr = (sp.get('address') || '').trim();
      if (!SOL_ADDR.test(addr)) return writeJson(res, 400, { error: 'Invalid address.' });
      const domain = req.headers.host || 'localhost';
      return writeJson(res, 200, issueNonce(addr, domain, `${st.cfg.label} Binder`));
    }

    // POST trade/session   body: { address, signatureB64 } → { token }
    if (req.method === 'POST' && tr === 'session') {
      const { address, signatureB64 } = await readBody(req);
      if (!SOL_ADDR.test(address) || typeof signatureB64 !== 'string')
        return writeJson(res, 400, { error: 'address and signatureB64 required.' });
      const token = verifySignIn(address, signatureB64);
      if (!token) return writeJson(res, 401, { error: 'Invalid or expired signature.' });
      return writeJson(res, 200, { token });
    }

    // GET trade/intent?address=   → profile | 404
    if (req.method === 'GET' && tr === 'intent') {
      const sp   = new URL(req.url, 'http://local').searchParams;
      const addr = (sp.get('address') || '').trim();
      if (!SOL_ADDR.test(addr)) return writeJson(res, 400, { error: 'Invalid address.' });
      const profile = st.trade.getProfile(addr);
      if (!profile) return writeJson(res, 404, { error: 'No profile.' });
      return writeJson(res, 200, profile);
    }

    // POST trade/intent   auth + body: { haves, wants } → 200
    if (req.method === 'POST' && tr === 'intent') {
      const address = bearerAddress(req);
      if (!address) return writeJson(res, 401, { error: 'Not signed in.' });
      const { haves = [], wants = {} } = await readBody(req);
      if (!Array.isArray(haves) || !Array.isArray(wants.cards ?? []) || !Array.isArray(wants.traits ?? []))
        return writeJson(res, 400, { error: 'Invalid payload.' });
      // Validate haves are actually owned — strip unowned mints
      let validHaves = haves;
      if (HELIUS_RPC) {
        try {
          const cached = st.walletCache.get(address);
          const owned  = (cached && Date.now() - cached.ts < WALLET_TTL)
            ? cached.mints
            : await fetchWalletHoldings(st, address).then(m => { st.walletCache.set(address, { mints: m, ts: Date.now() }); return m; });
          const ownedSet = new Set(owned);
          validHaves = haves.filter(m => ownedSet.has(m));
        } catch {}
      }
      st.trade.upsertProfile(address, validHaves, wants);
      return writeJson(res, 200, { ok: true, haves: validHaves });
    }

    // DELETE trade/intent   auth → 200
    if (req.method === 'DELETE' && tr === 'intent') {
      const address = bearerAddress(req);
      if (!address) return writeJson(res, 401, { error: 'Not signed in.' });
      await readBody(req); // drain
      st.trade.deactivateProfile(address);
      return writeJson(res, 200, { ok: true });
    }

    // GET trade/matches?address=   → [{ matchAddress, iGive, theyGive }]
    if (req.method === 'GET' && tr === 'matches') {
      const sp   = new URL(req.url, 'http://local').searchParams;
      const addr = (sp.get('address') || '').trim();
      if (!SOL_ADDR.test(addr)) return writeJson(res, 400, { error: 'Invalid address.' });
      return writeJson(res, 200, st.trade.findMatches(addr));
    }

    // GET trade/board   → all active profiles (public want lists)
    if (req.method === 'GET' && tr === 'board') {
      return writeJson(res, 200, st.trade.getAllActiveProfiles());
    }

    return writeJson(res, 404, { error: 'Unknown trade route.' });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Bind to loopback only: the public path is the Tailscale Funnel (→ 127.0.0.1:8787).
// This keeps the raw HTTP port off every external interface as defense-in-depth.
server.listen(PORT, '127.0.0.1', () => {
  const live = !!HELIUS_RPC;
  console.log(`Binder server running on http://127.0.0.1:${PORT}`);
  console.log(`Collections: ${Object.values(COLLECTIONS).map(c => `${c.label} (${c.htmlRoutes[0]})`).join(', ')}`);
  console.log(`Collection data: ${live ? 'LIVE (newest-poll 5min + hourly reconcile, slim+gzip)' : 'static snapshot'}`);
  console.log(`Listings: proxied + gzip + cached 30s.`);
  loadSessionsFromDisk();
  let stagger = 0;
  for (const st of Object.values(STATES)) {
    st.trade.loadFromDisk();
    if (st.un) warmUnmintedFromDisk(st);
    if (live) {
      warmFromDisk(st);                                    // instant serve from last snapshot
      setTimeout(() => {
        revalidateCollection(st);                          // full fetch now (cold start)
        setInterval(() => revalidateNewest(st), NEWEST_POLL_MS);       // cheap: catch new mints fast (~10 credits/poll)
        setInterval(() => revalidateCollection(st), FULL_RECONCILE_MS);// full reconcile hourly (catch burns/edits)
      }, stagger);
      stagger += 30_000;   // avoid synchronized Helius bursts across collections
    }
  }
});
