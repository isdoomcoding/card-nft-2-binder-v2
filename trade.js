/**
 * trade.js — SIWS auth, intent store, two-way match engine.
 * Zero runtime dependencies — pure node:crypto + fs.
 *
 * Auth (nonces/sessions) is module-level and shared: a session proves wallet
 * ownership, so one sign-in is valid across every collection's binder.
 * Intents + trait maps are per-collection — build one with createIntentStore().
 */
import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_PATH = path.join(__dirname, 'data', 'trade-sessions.json');

const NONCE_TTL   = 5  * 60 * 1000;   // 5 min to sign
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 h

const sessions = new Map();   // token   → { address, expires }
const nonces   = new Map();   // address → { message, expires }

export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Base58 decoder (for Solana pubkeys) ──────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const d = B58.indexOf(c);
    if (d < 0) throw new Error('Invalid base58 char: ' + c);
    n = n * 58n + BigInt(d);
  }
  let zeros = 0;
  for (const c of str) { if (c === '1') zeros++; else break; }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

// ── ed25519 verify (node:crypto — no external packages) ─────────────────────
// Wraps the raw 32-byte pubkey in a minimal SPKI DER envelope.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifySolanaSignature(pubkeyB58, message, signatureB64) {
  try {
    const pub = base58Decode(pubkeyB58);
    if (pub.length !== 32) return false;
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, pub]),
      format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObj, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

// ── SIWS nonce & session (shared across collections) ─────────────────────────
export function issueNonce(address, domain = 'localhost', appLabel = 'Card NFT 2 Binder') {
  const nonce    = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const message  = [
    `${appLabel} wants you to sign in with your Solana account:`,
    address, '',
    'Sign in to manage your trade profile.', '',
    `Domain: ${domain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
  nonces.set(address, { message, expires: Date.now() + NONCE_TTL });
  return { nonce, message };
}

export function verifySignIn(address, signatureB64) {
  const pending = nonces.get(address);
  if (!pending || Date.now() > pending.expires) return null;
  if (!verifySolanaSignature(address, pending.message, signatureB64)) return null;
  nonces.delete(address);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { address, expires: Date.now() + SESSION_TTL });
  _persistSessions();
  return token;
}

export function resolveToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || Date.now() > s.expires) return null;
  return s.address;
}

function _persistSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });
    const alive = [...sessions.entries()]
      .filter(([, s]) => Date.now() < s.expires)
      .map(([token, s]) => ({ token, address: s.address, expires: s.expires }));
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(alive, null, 2));
  } catch {}
}

export function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      if (Array.isArray(data)) {
        let alive = 0;
        for (const s of data)
          if (s?.token && s?.address && Date.now() < s.expires) {
            sessions.set(s.token, { address: s.address, expires: s.expires });
            alive++;
          }
        console.log(`[trade] ${alive} session(s) restored`);
      }
    }
  } catch {}
}

// ── Per-collection intent store + two-way match engine ──────────────────────
export function createIntentStore(intentsFile) {
  const INTENTS_PATH = path.isAbsolute(intentsFile) ? intentsFile : path.join(__dirname, intentsFile);
  const intents = new Map();   // address → profile
  let _mintTraits = null;      // mint → { traitKey: traitValue } — set by setCollectionData()

  function getProfile(address) {
    return intents.get(address) ?? null;
  }

  function upsertProfile(address, haves, wants) {
    const now  = new Date().toISOString();
    const prev = intents.get(address);
    intents.set(address, {
      address,
      haves:  Array.isArray(haves) ? haves : [],
      wants: {
        cards:  Array.isArray(wants?.cards)  ? wants.cards  : [],
        traits: Array.isArray(wants?.traits) ? wants.traits : [],
      },
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      active: true,
    });
    _persistIntents();
  }

  function deactivateProfile(address) {
    const p = intents.get(address);
    if (!p) return;
    p.active    = false;
    p.updatedAt = new Date().toISOString();
    _persistIntents();
  }

  function getAllActiveProfiles() {
    return [...intents.values()].filter(p => p.active);
  }

  // Returns [{ matchAddress, iGive:[mint,...], theyGive:[mint,...] }]
  function findMatches(address) {
    const mine = intents.get(address);
    if (!mine?.active || !mine.haves.length) return [];
    const results = [];
    for (const [other, profile] of intents) {
      if (other === address || !profile.active || !profile.haves.length) continue;
      const iGive    = _satisfies(mine.haves,    profile.wants);
      const theyGive = _satisfies(profile.haves, mine.wants);
      if (iGive.length && theyGive.length)
        results.push({ matchAddress: other, iGive, theyGive });
    }
    return results;
  }

  // Which mints from `haves` satisfy the `wants` side (specific cards + trait wants)?
  function _satisfies(haves, wants) {
    const wantSet = new Set(wants?.cards ?? []);
    return haves.filter(mint => {
      if (wantSet.has(mint)) return true;
      if (!_mintTraits || !wants?.traits?.length) return false;
      const attrs = _mintTraits[mint];
      if (!attrs) return false;
      return wants.traits.some(w => attrs[w.trait] === w.value);
    });
  }

  function setCollectionData(assets) {
    _mintTraits = {};
    for (const a of assets) {
      const map = {};
      for (const attr of (a?.content?.metadata?.attributes ?? [])) {
        if (attr?.trait_type != null && attr?.value != null)
          map[String(attr.trait_type)] = String(attr.value);
      }
      _mintTraits[a.id] = map;
    }
  }

  function _persistIntents() {
    try {
      fs.mkdirSync(path.dirname(INTENTS_PATH), { recursive: true });
      fs.writeFileSync(INTENTS_PATH, JSON.stringify([...intents.values()], null, 2));
    } catch {}
  }

  function loadFromDisk() {
    try {
      if (fs.existsSync(INTENTS_PATH)) {
        const data = JSON.parse(fs.readFileSync(INTENTS_PATH, 'utf8'));
        if (Array.isArray(data)) {
          for (const p of data) if (p?.address) intents.set(p.address, p);
          console.log(`[trade] ${intents.size} profile(s) loaded (${path.basename(INTENTS_PATH)})`);
        }
      }
    } catch {}
  }

  return { getProfile, upsertProfile, deactivateProfile, getAllActiveProfiles,
           findMatches, setCollectionData, loadFromDisk };
}
