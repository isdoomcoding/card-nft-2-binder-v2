#!/usr/bin/env node
/**
 * minimal-server.js — Production for 100–200 users
 * ==========================================================================
 * Collection:
 *   a) Set SERVER_HELIUS_KEY in env → live shared mode (cached ~90s).
 *   b) No key → static snapshot from data/card-nft-2-collection.json.
 *
 * Listings:
 *   Magic Eden (GET) and Tensor (POST) are proxied through the server,
 *   cached server-side for 30–60s so one upstream call serves many users.
 *
 * Run:
 *   SERVER_HELIUS_KEY=... node minimal-server.js
 */

import http from 'http';
import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const SNAPSHOT_PATH = path.join(__dirname, 'data', 'card-nft-2-collection.json');

// === Optional Helius key for live shared collection ===
const HELIUS_KEY = process.env.SERVER_HELIUS_KEY || process.env.HELIUS_RPC_KEY || '';
const HELIUS_RPC = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';  // shared secret Helius sends as Authorization

// === Collection cache (live mode) ===
// Holds slim data + precomputed JSON/gzip buffers so each request is just a buffer write.
let collectionCache = null;        // { data, ts, body:Buffer, gzip:Buffer }
let refreshing = false;            // guards background revalidation
const COLLECTION_TTL = 90_000;     // 90s "fresh"; stale entries are still served (SWR)
const NEWEST_POLL_MS = 300_000;    // 5min safety-net poll (the Helius webhook drives realtime now)
const FULL_RECONCILE_MS = 3_600_000; // 1h: full collection reconcile (catches burns / edits)
const SLIM_SNAPSHOT = path.join(__dirname, 'data', 'collection-slim.json');

// === Listings cache ===
const listingsCache = new Map();
const LISTINGS_TTL = 30_000;

// === Wallet holdings cache (per address) ===
const COLLECTION_GROUP = 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu';
const walletCache = new Map();      // address -> { mints:[], ts }
const WALLET_TTL = 60_000;          // 60s

function isFresh(cache, ttl) {
  const e = cache instanceof Map ? listingsCache.get(cache) : cache;
  const ts = cache instanceof Map ? (e?.ts || 0) : (cache?.ts || 0);
  return e && (Date.now() - ts < ttl);
}

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

// Keep only the fields the binder UI actually reads → ~3x smaller payload.
function slimAsset(a) {
  const md = a?.content?.metadata || {};
  const image = a?.content?.links?.image
    || (a?.content?.files || []).find(f => f?.mime && String(f.mime).startsWith('image'))?.uri
    || null;
  return { id: a?.id, content: { metadata: { name: md.name, attributes: md.attributes || [] }, links: { image } } };
}

function buildCollectionCache(data) {
  const body = Buffer.from(JSON.stringify(data));
  return { data, ts: Date.now(), body, gzip: zlib.gzipSync(body) };
}

// === Helius fetch (slimmed) ===
async function fetchCollectionLive() {
  const all = [];
  const seen = new Set();
  let page = 1;
  while (page <= 25) {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'live', method: 'getAssetsByGroup',
      params: { groupKey: 'collection', groupValue: COLLECTION_GROUP, page, limit: 500,
                sortBy: { sortBy: 'created', sortDirection: 'desc' } }
    });
    const r = await fetch(HELIUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    const items = j.result?.items || [];
    for (const it of items) { if (it?.id && !it.burnt && !seen.has(it.id)) { seen.add(it.id); all.push(slimAsset(it)); } }
    if (items.length < 500) break;
    page++;
  }
  // Array is newest-first (created desc). Stamp a mint-rank so the client can sort
  // by true creation order: higher m = more recently minted.
  const n = all.length;
  for (let i = 0; i < n; i++) all[i].m = n - 1 - i;
  return all;
}

// Which mints from THIS collection a given wallet currently holds.
async function fetchWalletHoldings(addr) {
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
      const inColl = (it?.grouping || []).some(g => g?.group_key === 'collection' && g?.group_value === COLLECTION_GROUP);
      if (inColl && it?.id && !it.burnt) mints.push(it.id);
    }
    if (items.length < 1000) break;
    page++;
  }
  return mints;
}

// Refresh the collection cache in the background (stale-while-revalidate).
async function revalidateCollection() {
  if (refreshing || !HELIUS_RPC) return;
  refreshing = true;
  try {
    const data = await fetchCollectionLive();
    if (data.length) {
      collectionCache = buildCollectionCache(data);
      try { fs.mkdirSync(path.dirname(SLIM_SNAPSHOT), { recursive: true }); fs.writeFileSync(SLIM_SNAPSHOT, collectionCache.body); } catch {}
    }
  } catch { /* keep serving the previous cache */ }
  finally { refreshing = false; }
}

// Cheap poll: fetch only the most-recently-created assets (1 call) and merge any
// new mints into the cache. ~10 credits/poll vs ~190 for a full refresh.
async function fetchNewestAssets(limit = 100) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'newest', method: 'getAssetsByGroup',
    params: {
      groupKey: 'collection', groupValue: COLLECTION_GROUP,
      page: 1, limit,
      sortBy: { sortBy: 'created', sortDirection: 'desc' }
    }
  });
  const r = await fetch(HELIUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return (j.result?.items || []).filter(it => it?.id && !it.burnt).map(slimAsset);
}

async function revalidateNewest() {
  if (!HELIUS_RPC || refreshing) return;          // don't overlap a full reconcile
  if (!collectionCache) return revalidateCollection(); // cold start -> do a full fetch
  try {
    const newest = await fetchNewestAssets(100);
    const have = new Set(collectionCache.data.map(a => a.id));
    const fresh = newest.filter(a => a.id && !have.has(a.id));
    if (fresh.length) {
      let maxM = 0;
      for (const a of collectionCache.data) if (typeof a.m === 'number' && a.m > maxM) maxM = a.m;
      fresh.forEach((a, i) => { a.m = maxM + fresh.length - i; }); // fresh is newest-first -> newest gets the top rank
      const data = [...fresh, ...collectionCache.data];
      collectionCache = buildCollectionCache(data);
      try { fs.writeFileSync(SLIM_SNAPSHOT, collectionCache.body); } catch {}
      console.log(`[newest] merged +${fresh.length} new asset(s) -> ${data.length}`);
    } else {
      collectionCache.ts = Date.now();            // keep cache "fresh" so SWR won't force a full refetch
    }
  } catch { /* keep serving the previous cache */ }
}

// Webhook hits can arrive in bursts (a mint tx touches several watched accounts);
// coalesce them into one cheap newest-poll every few seconds.
let _whDebounce = null;
function scheduleNewestPoll() {
  if (_whDebounce) return;
  _whDebounce = setTimeout(() => { _whDebounce = null; revalidateNewest(); }, 3000);
}

// On startup, warm instantly from the slim disk snapshot (marked stale so it revalidates).
function warmFromDisk() {
  try {
    if (fs.existsSync(SLIM_SNAPSHOT)) {
      const data = JSON.parse(fs.readFileSync(SLIM_SNAPSHOT, 'utf8'));
      if (Array.isArray(data) && data.length) { collectionCache = buildCollectionCache(data); collectionCache.ts = 0; }
    }
  } catch {}
}

// === Create server ===
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }

  // Helius webhook: a tx touched the mint authority / collection -> pull the new mint(s)
  // in via a cheap newest-poll. Token-gated so randoms can't trigger credit spend.
  if (req.method === 'POST' && p === '/helius-webhook') {
    if (!WEBHOOK_SECRET || req.headers['authorization'] !== WEBHOOK_SECRET) {
      req.resume(); res.writeHead(401); return res.end('unauthorized');
    }
    req.resume();                 // drain the body, we don't need to parse it
    scheduleNewestPoll();         // debounced -> instant-ish merge of just-minted assets
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // 1. /collection — slim + gzip, warm cache (SWR). Supports ?limit=&offset= for fast first paint.
  if (req.method === 'GET' && p === '/collection') {
    const sp = new URL(req.url, 'http://local').searchParams;
    const limit = Math.max(0, Math.min(20000, parseInt(sp.get('limit') || '0', 10) || 0));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);

    if (HELIUS_RPC) {
      // Ensure cache exists (cold start fetches once, then it stays warm via SWR).
      if (!collectionCache) {
        try {
          const data = await fetchCollectionLive();
          collectionCache = buildCollectionCache(data);
          try { fs.mkdirSync(path.dirname(SLIM_SNAPSHOT), { recursive: true }); fs.writeFileSync(SLIM_SNAPSHOT, collectionCache.body); } catch {}
        } catch (e) {
          return writeJson(res, 503, { error: 'failed to fetch live collection', detail: String(e) });
        }
      } else if (!isFresh(collectionCache, COLLECTION_TTL)) {
        revalidateCollection(); // refresh in background; serve current copy now
      }
      const xsrc = isFresh(collectionCache, COLLECTION_TTL) ? 'server-cache' : 'server-cache-stale';

      // Partial slice → instant first paint
      if (limit > 0) {
        const slice = collectionCache.data.slice(offset, offset + limit);
        return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slice)), 'application/json',
          { 'x-source': xsrc, 'x-partial': 'true', 'x-total': String(collectionCache.data.length), 'cache-control': 'public, max-age=30' });
      }

      // Full payload → serve precomputed buffers
      const hdr = { 'x-source': xsrc, 'cache-control': 'public, max-age=60' };
      if (clientAcceptsGzip(req)) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-encoding': 'gzip', 'vary': 'accept-encoding', ...hdr });
        return res.end(collectionCache.gzip);
      }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...hdr });
      return res.end(collectionCache.body);
    }

    // Static snapshot fallback (no key) — slimmed on the way out
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return writeJson(res, 503, { error: 'no snapshot', hint: 'Set SERVER_HELIUS_KEY or run snapshot-collection.js' });
    }
    try {
      let slim = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')).map(slimAsset);
      if (limit > 0) slim = slim.slice(offset, offset + limit);
      return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(slim)), 'application/json', { 'x-source': 'static-snapshot' });
    } catch (e) {
      return writeJson(res, 500, { error: 'failed to read snapshot' });
    }
  }

  // 1b. /wallet?address=<addr> — which cards from this collection a wallet holds
  if (req.method === 'GET' && p === '/wallet') {
    if (!HELIUS_RPC) return writeJson(res, 503, { error: 'Wallet lookup needs a server Helius key.' });
    const sp = new URL(req.url, 'http://local').searchParams;
    const addr = (sp.get('address') || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return writeJson(res, 400, { error: 'Invalid Solana address.' });
    const cached = walletCache.get(addr);
    if (cached && Date.now() - cached.ts < WALLET_TTL) {
      return writeJson(res, 200, { address: addr, count: cached.mints.length, mints: cached.mints }, { 'x-source': 'wallet-cache' });
    }
    try {
      const mints = await fetchWalletHoldings(addr);
      walletCache.set(addr, { mints, ts: Date.now() });
      return writeJson(res, 200, { address: addr, count: mints.length, mints }, { 'x-source': 'helius-live' });
    } catch (e) {
      return writeJson(res, 502, { error: 'Wallet lookup failed.', detail: String(e) });
    }
  }

  // 2. Magic Eden listings (GET, cached)
  if (req.method === 'GET' && p === '/listings/card_nft_2') {
    // Sanitize input: only offset/limit are honoured, clamped to sane ranges.
    // This bounds the cache keyspace and prevents arbitrary query passthrough.
    const sp = new URL(req.url, 'http://local').searchParams;
    const offset = Math.max(0, Math.min(100000, parseInt(sp.get('offset') || '0', 10) || 0));
    const limit = Math.max(1, Math.min(500, parseInt(sp.get('limit') || '100', 10) || 100));
    const cleanQs = `?offset=${offset}&limit=${limit}`;
    const key = 'me' + cleanQs;
    if (isFresh(key, LISTINGS_TTL)) return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(listingsCache.get(key).data)), 'application/json', { 'x-cached': 'true' });

    const target = `https://api-mainnet.magiceden.dev/v2/collections/card_nft_2/listings${cleanQs}`;
    const url = new URL(target);
    const lib = url.protocol === 'https:' ? https : http;
    const r = lib.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'GET', headers: { 'accept': 'application/json', 'user-agent': 'binder/1.0' } }, (up) => {
      let body = '';
      up.on('data', c => body += c);
      up.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        const ok = up.statusCode >= 200 && up.statusCode < 300 && Array.isArray(json);
        if (ok) {
          listingsCache.set(key, { data: json, ts: Date.now() });
          return sendBuffer(req, res, 200, Buffer.from(JSON.stringify(json)), 'application/json', { 'x-cached': 'false' });
        }
        // ME hiccup (rate-limit/5xx/garbage): serve last good cache, else empty — never 502
        const c = listingsCache.get(key);
        sendBuffer(req, res, 200, Buffer.from(JSON.stringify(c ? c.data : [])), 'application/json', { 'x-cached': c ? 'stale' : 'empty' });
      });
    });
    r.on('error', () => {
      const c = listingsCache.get(key);
      sendBuffer(req, res, 200, Buffer.from(JSON.stringify(c ? c.data : [])), 'application/json', { 'x-cached': c ? 'stale' : 'empty' });
    });
    r.setTimeout(8000, () => r.destroy());  // don't hang on a slow ME; triggers the error path -> stale/empty
    r.end();
    return;
  }

  // 3. Tensor is dead for this collection (tensor-api.tensor.so no longer resolves;
  //    Tensor moved to a keyed API). Return an empty 200 so the client falls through
  //    cleanly instead of the browser logging 502s. Drain the POST body first.
  if (req.method === 'POST' && p === '/listings/tensor') {
    req.resume();
    return writeJson(res, 200, {});
  }

  // 4. Static files — STRICT allowlist.
  // Paths are hardcoded — never derived from the URL — so no traversal risk.
  const STATIC = {
    '/':                      ['card-nft-2-binder.html', 'text/html; charset=utf-8',  'no-cache'],
    '/card-nft-2-binder.html':['card-nft-2-binder.html', 'text/html; charset=utf-8',  'no-cache'],
    '/img/grain.webp':        ['img/grain.webp',          'image/webp',                'public, max-age=31536000, immutable'],
    '/img/glitter.png':       ['img/glitter.png',         'image/png',                 'public, max-age=31536000, immutable'],
  };
  const staticEntry = req.method === 'GET' && STATIC[p];
  if (staticEntry) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, staticEntry[0]));
      return sendBuffer(req, res, 200, raw, staticEntry[1], { 'cache-control': staticEntry[2] });
    } catch {
      res.writeHead(500); return res.end('server error');
    }
  }

  // Anything else → 404. No filesystem path is ever derived from the URL.
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Bind to loopback only: the public path is the Tailscale Funnel (→ 127.0.0.1:8787).
// This keeps the raw HTTP port off every external interface as defense-in-depth.
server.listen(PORT, '127.0.0.1', () => {
  const live = !!HELIUS_RPC;
  console.log(`Card NFT 2 binder running on http://127.0.0.1:${PORT}`);
  console.log(`Collection: ${live ? 'LIVE (newest-poll 60s + hourly reconcile, slim+gzip)' : 'static snapshot'}`);
  console.log(`Listings: proxied + gzip + cached 45s.`);
  if (live) {
    warmFromDisk();                              // instant serve from last snapshot
    revalidateCollection();                              // full fetch now (cold start)
    setInterval(revalidateNewest, NEWEST_POLL_MS);       // cheap: catch new mints fast (~10 credits/poll)
    setInterval(revalidateCollection, FULL_RECONCILE_MS);// full reconcile hourly (catch burns/edits)
  }
});
