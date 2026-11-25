import console from 'node:console';
import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir = resolve('.runtime/zk-issuer');
mkdirSync(dir, { recursive: true });
const priv = resolve(dir, 'private.pem'),
  pub = resolve(dir, 'public.pem');
if (existsSync(priv) !== existsSync(pub))
  throw new Error('Incomplete issuer key pair; restore it instead of rotating');
if (!existsSync(priv)) {
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(priv, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
}
const key = createPrivateKey(readFileSync(priv)),
  publicKey = createPublicKey(readFileSync(pub));
if (
  key.asymmetricKeyType !== 'ed25519' ||
  !createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .equals(publicKey.export({ format: 'der', type: 'spki' }))
)
  throw new Error('Issuer key mismatch');
const env = resolve('.env.zk');
if (!existsSync(env)) writeFileSync(env, 'ZK_ENABLED=true\n', { flag: 'wx' });
console.log(
  'Preserved/generated a separate ZK issuer key pair. Public key ID: ' +
    createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex'),
);
