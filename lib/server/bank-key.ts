import "server-only";
import { b64url } from "@/lib/relay/encoding";
import { exportRawPublic, generateBankKey, importPrivateJwk, importRawPublic } from "@/lib/relay/keys";

type BankKeys = { priv: CryptoKey; pub: CryptoKey; pubB64: string };
const g = globalThis as { __blazeBankKeys?: Promise<BankKeys> };

/**
 * The demo "Ecobank" signing key. From env when set (run scripts/gen-bank-key.mjs); otherwise an
 * ephemeral key per server process — fine for local dev, but phones must re-fetch it after a restart.
 */
export function bankKeys(): Promise<BankKeys> {
  return (g.__blazeBankKeys ??= (async () => {
    const jwk = process.env.BANK_PRIVATE_KEY_JWK;
    const pubB64 = process.env.NEXT_PUBLIC_BANK_PUBLIC_KEY;
    if (jwk && pubB64) {
      return { priv: await importPrivateJwk(JSON.parse(jwk)), pub: await importRawPublic(b64url.decode(pubB64)), pubB64 };
    }
    const k = await generateBankKey();
    return { priv: k.privateKey, pub: k.publicKey, pubB64: b64url.encode(await exportRawPublic(k.publicKey)) };
  })());
}

export const nowS = () => Math.floor(Date.now() / 1000);

export const fail = (error: string, status = 400) => Response.json({ error }, { status });
