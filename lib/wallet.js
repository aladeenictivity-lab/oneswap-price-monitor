// Ed25519 wallet — load privkey from env, sign messages
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { hexToBytes, bytesToHex } from './util.js';

// Patch @noble/ed25519 to use sync sha512 from @noble/hashes (Node 20+ ESM)
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export class Wallet {
  /**
   * @param {string} privHex 32-byte (seed) or 64-byte (libsodium seed+pub) hex
   * @param {string} pubHex  32-byte hex (for verification)
   */
  constructor(privHex, pubHex) {
    const raw = hexToBytes(privHex);
    if (raw.length !== 32 && raw.length !== 64) {
      throw new Error(`privkey length ${raw.length}, expected 32 or 64`);
    }
    // Ed25519 sign uses 32-byte seed; libsodium 64-byte = seed||pub
    this.seed = raw.slice(0, 32);
    this.pubHex = pubHex.toLowerCase();
  }

  async ensureMatch() {
    const derived = await ed.getPublicKeyAsync(this.seed);
    const derivedHex = bytesToHex(derived);
    if (derivedHex !== this.pubHex) {
      throw new Error(
        `pubkey mismatch — derived ${derivedHex} vs expected ${this.pubHex}`
      );
    }
    return true;
  }

  /**
   * Sign a message and return signature bytes (64 bytes).
   * @param {Uint8Array} message
   * @returns {Promise<Uint8Array>}
   */
  async sign(message) {
    return await ed.signAsync(message, this.seed);
  }

  get publicKeyHex() {
    return this.pubHex;
  }
}
