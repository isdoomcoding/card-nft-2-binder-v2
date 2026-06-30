#!/usr/bin/env node
/**
 * snapshot-collection.js
 *
 * Fetches the FULL Card NFT 2 collection from Helius (using your key)
 * and writes a static JSON snapshot.
 *
 * This is the ONLY place your Helius key is ever used.
 * Run it manually or via cron before (or while) the server is running.
 *
 * Usage:
 *   HELIUS_RPC_KEY=yourkey node snapshot-collection.js
 *   # or put it in .env and source it, or hardcode temporarily.
 *
 * Output:
 *   data/card-nft-2-collection.json   (array of assets)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLECTION = 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu';
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'card-nft-2-collection.json');

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
  console.log('Snapshotting Card NFT 2 collection from Helius...');
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
  console.log('You can now start the server:  node listings-server.js');
}

main().catch(err => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
