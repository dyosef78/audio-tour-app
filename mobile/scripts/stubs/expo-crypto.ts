/**
 * expo-crypto's AES-GCM surface for the Node harness (TASK-1102), on node:crypto.
 *
 * Real encryption rather than a pass-through, so a test that tampers with a
 * ciphertext or swaps keys sees a genuine authentication failure. Mirrors the
 * SDK 57 contract checked in its .d.ts: 12-byte IV, 16-byte tag, combined layout
 * IV + ciphertext + tag, and a string BinaryInput meaning BASE64 - not text.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type BinaryInput = string | Uint8Array | ArrayBuffer;

// A const object, not an enum: the harness runs under Node's type stripping.
export const AESKeySize = { AES128: 128, AES192: 192, AES256: 256 } as const;
export type AESKeySize = (typeof AESKeySize)[keyof typeof AESKeySize];

const IV_BYTES = 12;
const TAG_BYTES = 16;

function toBuffer(input: BinaryInput): Buffer {
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  return Buffer.from(input);
}

export class AESEncryptionKey {
  readonly raw: Buffer;

  private constructor(raw: Buffer) {
    this.raw = raw;
  }

  get size(): AESKeySize {
    return (this.raw.length * 8) as AESKeySize;
  }

  static async generate(size: AESKeySize = AESKeySize.AES256): Promise<AESEncryptionKey> {
    return new AESEncryptionKey(randomBytes(size / 8));
  }

  static async import(input: Uint8Array | string, encoding?: 'hex' | 'base64'): Promise<AESEncryptionKey> {
    const raw = typeof input === 'string' ? Buffer.from(input, encoding ?? 'hex') : Buffer.from(input);
    if (![16, 24, 32].includes(raw.length)) throw new Error(`Invalid AES key length: ${raw.length} bytes`);
    return new AESEncryptionKey(raw);
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.raw);
  }

  async encoded(encoding: 'hex' | 'base64'): Promise<string> {
    return this.raw.toString(encoding);
  }
}

export class AESSealedData {
  private readonly data: Buffer;

  private constructor(data: Buffer) {
    this.data = data;
  }

  static fromCombined(combined: BinaryInput): AESSealedData {
    const data = toBuffer(combined);
    if (data.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed data is too short');
    return new AESSealedData(data);
  }

  static fromParts(iv: BinaryInput, ciphertext: BinaryInput, tag: BinaryInput): AESSealedData {
    return new AESSealedData(Buffer.concat([toBuffer(iv), toBuffer(ciphertext), toBuffer(tag)]));
  }

  get iv(): Buffer {
    return this.data.subarray(0, IV_BYTES);
  }
  get body(): Buffer {
    return this.data.subarray(IV_BYTES, this.data.length - TAG_BYTES);
  }
  get authTag(): Buffer {
    return this.data.subarray(this.data.length - TAG_BYTES);
  }

  async combined(encoding: 'bytes' | 'base64' = 'bytes'): Promise<string | Uint8Array> {
    return encoding === 'base64' ? this.data.toString('base64') : new Uint8Array(this.data);
  }
}

export async function aesEncryptAsync(
  plaintext: BinaryInput,
  key: AESEncryptionKey,
  options: { additionalData?: BinaryInput } = {},
): Promise<AESSealedData> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(`aes-${key.size}-gcm`, key.raw, iv, { authTagLength: TAG_BYTES });
  if (options.additionalData !== undefined) cipher.setAAD(toBuffer(options.additionalData));
  const body = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()]);
  return AESSealedData.fromParts(iv, body, cipher.getAuthTag());
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { output?: 'bytes' | 'base64'; additionalData?: BinaryInput } = {},
): Promise<string | Uint8Array> {
  const decipher = createDecipheriv(`aes-${key.size}-gcm`, key.raw, sealed.iv, { authTagLength: TAG_BYTES });
  if (options.additionalData !== undefined) decipher.setAAD(toBuffer(options.additionalData));
  decipher.setAuthTag(sealed.authTag);
  const plain = Buffer.concat([decipher.update(sealed.body), decipher.final()]);
  return options.output === 'base64' ? plain.toString('base64') : new Uint8Array(plain);
}
