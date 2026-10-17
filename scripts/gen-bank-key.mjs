// Generates the demo "Ecobank" signing key pair for pocket certificates.
// Usage: node scripts/gen-bank-key.mjs  → paste the two lines into .env.local (and Vercel env).
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const b64url = Buffer.from(raw).toString("base64url");
console.log(`BANK_PRIVATE_KEY_JWK='${JSON.stringify(jwk)}'`);
console.log(`NEXT_PUBLIC_BANK_PUBLIC_KEY=${b64url}`);
