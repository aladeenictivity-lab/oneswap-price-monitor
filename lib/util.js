// Helper utilities

export function hexToBytes(hex) {
  hex = hex.trim().replace(/^0x/, '').replace(/\s+/g, '');
  if (hex.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(b) {
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(b) {
  return Buffer.from(b).toString('base64');
}

export function base64ToBytes(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function hexToBase64(hex) {
  return bytesToBase64(hexToBytes(hex));
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
