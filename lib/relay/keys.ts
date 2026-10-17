// ECDSA P-256 via WebCrypto: available in every modern browser (incl. iOS Safari) and Node 20+.
// Not HMAC — the merchant must be able to verify without holding anything that could forge.

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** Device keys are non-extractable: the private key can sign but can never be read out of IndexedDB. */
export const generateDeviceKey = () =>
  crypto.subtle.generateKey(ALG, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;

/** Bank keys are extractable so the setup script can export them to env vars. */
export const generateBankKey = () =>
  crypto.subtle.generateKey(ALG, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

export const exportRawPublic = async (k: CryptoKey) =>
  new Uint8Array(await crypto.subtle.exportKey("raw", k));

export const importRawPublic = (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", raw as BufferSource, ALG, true, ["verify"]);

export const importPrivateJwk = (jwk: JsonWebKey) =>
  crypto.subtle.importKey("jwk", jwk, ALG, false, ["sign"]);

export const sign = async (k: CryptoKey, data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign(SIGN, k, data as BufferSource));

export const verify = (k: CryptoKey, sig: Uint8Array, data: Uint8Array) =>
  crypto.subtle.verify(SIGN, k, sig as BufferSource, data as BufferSource).catch(() => false);
