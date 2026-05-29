import crypto from 'crypto';

const KEY = Buffer.from((process.env.ENCRYPTION_KEY || 'fleetos_dev_enc_key_32chars!!!!!').slice(0, 32));

export async function encrypt(text: string): Promise<string> {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = (cipher as any).getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function decrypt(encoded: string): Promise<string> {
  const [ivHex, tagHex, encHex] = encoded.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm',
    KEY, Buffer.from(ivHex, 'hex'));
  (decipher as any).setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}
