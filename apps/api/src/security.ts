import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ApiFailure } from './errors.js';

export interface PasswordMaterial {
  profile: 'scrypt-v1';
  salt_hex: string;
  derived_key_hex: string;
}
let activeHashes = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (activeHashes >= 2) throw new ApiFailure(429, 'BUSY', 'Authentication busy; retry later');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(salt, 'hex'),
        64,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    activeHashes--;
  }
}

export async function hashPassword(password: string): Promise<PasswordMaterial> {
  if (password.length < 14 || password.length > 128 || Buffer.byteLength(password) > 512) {
    throw new Error('Provisioned passwords must contain 14 to 128 characters');
  }
  const salt_hex = randomBytes(16).toString('hex');
  return {
    profile: 'scrypt-v1',
    salt_hex,
    derived_key_hex: (await derive(password, salt_hex)).toString('hex'),
  };
}

export const dummyPassword: PasswordMaterial = {
  profile: 'scrypt-v1',
  salt_hex: randomBytes(16).toString('hex'),
  derived_key_hex: randomBytes(64).toString('hex'),
};

export async function verifyPassword(
  password: string,
  material: PasswordMaterial,
): Promise<boolean> {
  if (
    material.profile !== 'scrypt-v1' ||
    !/^[a-f0-9]{32}$/.test(material.salt_hex) ||
    !/^[a-f0-9]{128}$/.test(material.derived_key_hex)
  )
    throw new Error('Unsupported password material');
  const actual = await derive(password, material.salt_hex);
  return timingSafeEqual(actual, Buffer.from(material.derived_key_hex, 'hex'));
}

export const digestToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export class WindowLimiter {
  private entries = new Map<string, { count: number; end: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now = Date.now,
  ) {}
  take(key: string) {
    const now = this.now();
    for (const [id, value] of this.entries) if (value.end <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 1000) throw new ApiFailure(429, 'RATE_LIMITED', 'Retry later');
      entry = { count: 0, end: now + this.windowMs };
      this.entries.set(key, entry);
    }
    if (++entry.count > this.limit) throw new ApiFailure(429, 'RATE_LIMITED', 'Retry later');
  }
}
