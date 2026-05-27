// Canton API client (consolewallet.io)
// Handles login + token-standard transfer (prepare → sign → submit)

import { hexToBase64, bytesToBase64, base64ToBytes, nowIso } from './util.js';

export class CantonClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {import('./wallet.js').Wallet} opts.wallet
   * @param {string} opts.partyId
   * @param {object} [opts.logger]
   */
  constructor({ baseUrl, wallet, partyId, logger = console }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.wallet = wallet;
    this.partyId = partyId;
    this.logger = logger;
    this.cookies = '';
    this.pubBase64 = hexToBase64(wallet.publicKeyHex);
  }

  // Build headers — pubkey + cookie (after login)
  _headers(extra = {}) {
    return {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'console-wallet-public-key': this.pubBase64,
      'extension_version': '1.7.8',
      ...(this.cookies ? { 'cookie': this.cookies } : {}),
      ...extra,
    };
  }

  _saveCookies(setCookie) {
    if (!setCookie) return;
    // Naive: store all cookies as cookie header. setCookie may be array (Node 20 fetch).
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    const pairs = arr
      .map(c => c.split(';')[0].trim())
      .filter(Boolean);
    if (pairs.length) {
      this.cookies = pairs.join('; ');
    }
  }

  async _fetch(path, init = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    const maxRetries = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);
        const setCookie = res.headers.getSetCookie?.() || res.headers.get('set-cookie');
        this._saveCookies(setCookie);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        if (!res.ok) {
          const err = new Error(`Canton ${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      } catch (e) {
        lastErr = e;
        const isRetryable = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.name === 'AbortError' || e.type === 'system';
        if (attempt < maxRetries && isRetryable) {
          const delay = attempt * 2000;
          this.logger.warn?.(`[canton] retry ${attempt}/${maxRetries} after ${delay}ms: ${e.message}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  /** POST /api/v1/auth/session — sets session cookie */
  async login() {
    await this._fetch('/api/v1/auth/session', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ publicKey: this.pubBase64 }),
    });
    this.logger.info?.(`[canton] login ok, cookies stored`);
    return true;
  }

  /** GET /api/v1/token-standard/balances?partyId=... */
  async getBalances() {
    return await this._fetch(
      `/api/v1/token-standard/balances?partyId=${encodeURIComponent(this.partyId)}`,
      { method: 'GET', headers: this._headers() },
    );
  }

  /**
   * POST /api/v1/token-standard/transfer/prepare
   * @param {object} p
   * @param {string} p.receiver  party ID receiver
   * @param {string} p.amount    decimal string
   * @param {string} p.coin      "CC" / "USDCx"
   * @param {string} [p.memo]    deposit reference
   * @param {string} [p.expiryDate] ISO; default: now + 24h
   */
  async prepareTransfer({ receiver, amount, coin, memo, expiryDate }) {
    const body = {
      sender: this.partyId,
      receiver,
      amount: String(amount),
      coin: coin || 'CC',
      ...(memo ? { memo } : {}),
      expiryDate: expiryDate || new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    return await this._fetch('/api/v1/token-standard/transfer/prepare', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
  }

  /**
   * Sign preparedTransactionHash (base64) and POST /api/v1/token-standard/transfer/submit
   * @param {object} prepared response from prepareTransfer
   */
  async submitTransfer(prepared) {
    const hashBytes = base64ToBytes(prepared.preparedTransactionHash);
    const sigBytes = await this.wallet.sign(hashBytes);
    const body = {
      preparedTransfer: {
        hashingDetails: prepared.hashingDetails ?? null,
        hashingSchemeVersion: prepared.hashingSchemeVersion,
        preparedTransaction: prepared.preparedTransaction,
        preparedTransactionHash: prepared.preparedTransactionHash,
        submissionId: prepared.submissionId,
      },
      signature: bytesToBase64(sigBytes),
      publicKey: this.pubBase64,
      partyId: this.partyId,
    };
    return await this._fetch('/api/v1/token-standard/transfer/submit', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
  }

  /** Convenience: prepare + sign + submit */
  async sendCoin({ receiver, amount, coin, memo }) {
    const prepared = await this.prepareTransfer({ receiver, amount, coin, memo });
    this.logger.info?.(`[canton] prepared submissionId=${prepared.submissionId} fee=${prepared.feeCC} CC`);
    const submitted = await this.submitTransfer(prepared);
    this.logger.info?.(`[canton] submitted ledgerEnd=${submitted.ledgerEnd}`);
    return { prepared, submitted };
  }
}
