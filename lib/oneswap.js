// OneSwap API client (api.oneswap.cc)
// Auth: challenge → sign → verify → wallet-login
// Trade: swap-intent (quote+intent in one call) → poll status

import { bytesToBase64, sleep } from './util.js';

export class OneswapClient {
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
    this.challengeToken = null;  // aud: canton-swap-wallet (for swap-intent)
    this.userToken = null;       // aud: canton-swap-user (for /user/*)
    this.userId = null;
  }

  _headers(extra = {}, useUser = false) {
    const tok = useUser ? this.userToken : this.challengeToken;
    return {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'origin': 'https://oneswap.cc',
      'referer': 'https://oneswap.cc/',
      ...(tok ? { 'authorization': `Bearer ${tok}` } : {}),
      ...extra,
    };
  }

  async _fetch(path, init = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const err = new Error(`OneSwap ${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /** Full login: challenge → sign → verify → wallet-login. Sets this.userToken */
  async login() {
    // 1. challenge
    const challenge = await this._fetch('/api/auth/challenge', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ partyId: this.partyId }),
    });
    this.logger.info?.(`[oneswap] got challenge nonce=${challenge.nonce.slice(0,16)}…`);

    // 2. sign message bytes (UTF-8)
    const msgBytes = new TextEncoder().encode(challenge.message);
    const sigBytes = await this.wallet.sign(msgBytes);

    // 3. verify
    const verify = await this._fetch('/api/auth/verify', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        partyId: this.partyId,
        nonce: challenge.nonce,
        signature: bytesToBase64(sigBytes),
        publicKey: this.wallet.publicKeyHex,
      }),
    });
    // Challenge token (aud: canton-swap-wallet) — used for swap-intent endpoints
    this.challengeToken = verify.token;
    this.logger.info?.(`[oneswap] verify ok, challenge token acquired`);

    // 4. wallet-login → user token (aud: canton-swap-user) — used for /user/* endpoints
    // Auth here uses the challenge token (Bearer)
    const wl = await this._fetch('/api/user/wallet-login', {
      method: 'POST',
      headers: this._headers({}, false), // challenge token
      body: JSON.stringify({
        walletPartyId: this.partyId,
        walletId: 'console',
      }),
    });
    this.userToken = wl.token;
    this.userId = wl.userId;
    this.logger.info?.(`[oneswap] login complete userId=${this.userId}`);
    return wl;
  }

  /** GET /api/user/me — useful for points/cohort/multiplier */
  async me() {
    return await this._fetch('/api/user/me', {
      method: 'GET',
      headers: this._headers({}, true), // user token
    });
  }

  /**
   * Create swap intent. The same endpoint also returns a quote.
   * @param {object} p
   * @param {string} p.poolId
   * @param {"CC"|"USDCx"|"CBTC"} p.inputToken
   * @param {string} p.amount  decimal input amount
   * @param {string} p.expectedOutputAmount decimal (you compute or use prior quote)
   * @param {string} p.minOutputAmount decimal (after slippage)
   * @param {number} p.slippageTolerance 0.01 = 1%
   */
  /** GET /api/v2/pools/{poolId}/quote — pure read-only quote, NO intent created. */
  async getQuote({ poolId, inputToken, inputAmount, receiverParty }) {
    const params = new URLSearchParams({ inputToken, inputAmount: String(inputAmount) });
    if (receiverParty) params.set('receiverParty', receiverParty);
    const url = `/api/v2/pools/${encodeURIComponent(poolId)}/quote?${params.toString()}`;
    return await this._fetch(url, {
      method: 'GET',
      headers: this._headers({}, false),
    });
  }

  async createSwapIntent({ poolId, inputToken, amount, expectedOutputAmount, minOutputAmount, slippageTolerance }) {
    return await this._fetch(`/api/v2/pools/${poolId}/swap-intent`, {
      method: 'POST',
      headers: this._headers({}, false), // challenge token (aud: canton-swap-wallet)
      body: JSON.stringify({
        inputToken,
        expectedAmount: String(amount),
        expectedOutputAmount: String(expectedOutputAmount),
        minOutputAmount: String(minOutputAmount),
        slippageTolerance,
        senderParty: this.partyId,
      }),
    });
  }

  /** GET intent status */
  async getIntent(poolId, intentId) {
    return await this._fetch(`/api/v2/pools/${poolId}/swap-intent/${intentId}`, {
      method: 'GET',
      headers: this._headers({}, false), // challenge token
    });
  }

  /** DELETE intent. Returns the cancelled intent or 404 if already gone. */
  async cancelIntent(poolId, intentId) {
    return await this._fetch(`/api/v2/pools/${poolId}/swap-intent/${intentId}`, {
      method: 'DELETE',
      headers: this._headers({}, false), // challenge token
    });
  }

  /** GET list of swap intents for our party. Returns array. */
  async listIntents(poolId) {
    return await this._fetch(`/api/v2/pools/${poolId}/swap-intents?sender=${encodeURIComponent(this.partyId)}`, {
      method: 'GET',
      headers: this._headers({}, false),
    });
  }

  /** Cancel ALL pending intents for our party. Useful before creating new quote. */
  async cancelAllPendingIntents(poolId) {
    let list;
    try {
      list = await this.listIntents(poolId);
    } catch (e) {
      this.logger.warn?.(`[oneswap] listIntents failed: ${e.message}`);
      return 0;
    }
    const intents = Array.isArray(list) ? list : (list.intents || list.data || list.items || []);
    let cancelled = 0;
    for (const it of intents) {
      const status = it.status || it.state || '';
      // Cancel if pending OR unknown status (API may omit status field)
      if ((status === 'pending' || !status) && (it.senderParty === this.partyId || !it.senderParty)) {
        try {
          await this.cancelIntent(poolId, it.id || it.intentId);
          this.logger.info?.(`[oneswap] cancelled stale intent ${it.id || it.intentId}`);
          cancelled++;
        } catch (e) {
          this.logger.warn?.(`[oneswap] cancel intent ${it.id || it.intentId} failed: ${e.message}`);
        }
      }
    }
    return cancelled;
  }

  /**
   * Poll intent until terminal status.
   * @returns final intent object
   */
  async pollIntent(poolId, intentId, { maxWaitSec = 600, intervalSec = 5 } = {}) {
    const deadline = Date.now() + maxWaitSec * 1000;
    while (Date.now() < deadline) {
      const i = await this.getIntent(poolId, intentId);
      if (i.status && i.status !== 'pending') {
        this.logger.info?.(`[oneswap] intent ${intentId} → ${i.status}`);
        return i;
      }
      await sleep(intervalSec * 1000);
    }
    throw new Error(`intent ${intentId} polling timeout after ${maxWaitSec}s`);
  }
}
