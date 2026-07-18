#!/usr/bin/env node
/**
 * snapshot-collection.js
 *
 * Fetches a FULL collection from Helius (using your key) and writes a
 * static JSON snapshot (the server's no-key fallback).
 *
 * Run it manually or via cron before (or while) the server is running.
 *
 * Usage:
 *   HELIUS_RPC_KEY=yourkey node snapshot-collection.js [card_nft_2|poncho]
 *   # defaults to card_nft_2; or put the key in .env and source it.
 *
 * Output:
 *   data/card-nft-2-collection.json | data/poncho-collection.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLECTIONS = {
  card_nft_2: { label: 'Card NFT 2', group: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu', out: 'card-nft-2-collection.json' },
  poncho:     { label: 'Poncho Drifella', group: 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH', out: 'poncho-collection.json' },
};

const slug = process.argv[2] || 'card_nft_2';
const cfg = COLLECTIONS[slug];
if (!cfg) {
  console.error(`ERROR: Unknown collection "${slug}". Use one of: ${Object.keys(COLLECTIONS).join(', ')}`);
  process.exit(1);
}

const COLLECTION = cfg.group;
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, cfg.out);

const HELIUS_KEY = process.env.HELIUS_RPC_KEY || process.env.VITE_HELIUS_RPC_KEY;
if (!HELIUS_KEY) {
  console.error('ERROR: Set HELIUS_RPC_KEY env var (your Helius key).');
  process.exit(1);
}

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function fetchPage(page, limit = 500) {
  const body = {
    jsonrpc: '2.0',
    id: 'snapshot',
    method: 'getAssetsByGroup',
    params: { groupKey: 'collection', groupValue: COLLECTION, page, limit },
  };
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result?.items || [];
}

async function main() {
  console.log(`Snapshotting ${cfg.label} collection from Helius...`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const seen = new Set();
  const all = [];
  const SAFETY = 30; // plenty for ~8-9k assets

  for (let p = 1; p <= SAFETY; p++) {
    const page = await fetchPage(p, 500);
    if (!page || page.length === 0) {
      console.log(`Page ${p} empty, stopping.`);
      break;
    }
    for (const item of page) {
      if (item?.id && !seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }
    console.log(`Page ${p}: +${page.length} (total unique so far: ${all.length})`);
    if (page.length < 500) break;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  console.log(`\nDone. Wrote ${all.length} assets to ${OUT_FILE}`);
  console.log('You can now start the server:  node minimal-server.js');
}

main().catch(err => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
