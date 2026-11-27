// Signs config/plans.json with the Ed25519 key in env PLANS_SIGNING_KEY (PEM PKCS8) and writes
// config/plans.json.sig (one line, base64) only when it changed. Refuses without config/plans.pub
// or when the key's public half does not match it. Never prints the key.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

const dir = new URL('../config/', import.meta.url);
const die = (m) => { console.error(`sign-plans: ${m}`); process.exit(1); };

const pubFile = new URL('plans.pub', dir);
if (!existsSync(pubFile)) die('config/plans.pub is missing');
const pem = process.env.PLANS_SIGNING_KEY;
if (!pem) die('PLANS_SIGNING_KEY is not set');

let priv;
try { priv = createPrivateKey(pem); } catch { die('PLANS_SIGNING_KEY is not a valid PEM private key'); }
if (priv.asymmetricKeyType !== 'ed25519') die('PLANS_SIGNING_KEY is not an Ed25519 key');

const wantX = Buffer.from(readFileSync(pubFile, 'utf8').trim(), 'base64').toString('base64url');
const gotX = createPublicKey(priv).export({ format: 'jwk' }).x;
if (wantX !== gotX) die('the signing key does not match config/plans.pub');

const data = readFileSync(new URL('plans.json', dir));
const line = `${sign(null, data, priv).toString('base64')}\n`;
const sigFile = new URL('plans.json.sig', dir);
if (existsSync(sigFile) && readFileSync(sigFile, 'utf8') === line) {
  console.log('sign-plans: signature unchanged');
} else {
  writeFileSync(sigFile, line);
  console.log('sign-plans: wrote config/plans.json.sig');
}
