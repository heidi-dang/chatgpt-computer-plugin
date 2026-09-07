import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const TICKET_VERSION = "v1";
const IV_BYTES = 12;

type Envelope<T> = {
  version: 1;
  kind: string;
  payload: T;
};

export class LiveTicketCodec {
  private readonly key: Buffer;

  constructor(secret?: string | Buffer) {
    const material = secret === undefined
      ? randomBytes(32)
      : Buffer.isBuffer(secret)
        ? secret
        : Buffer.from(secret, "utf8");
    if (material.byteLength < 16) {
      throw new Error("live ticket secret must contain at least 16 bytes");
    }
    this.key = createHash("sha256").update(material).digest();
  }

  seal<T>(kind: string, payload: T): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, kind, payload } satisfies Envelope<T>), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [TICKET_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
  }

  open<T>(ticket: string, expectedKind: string): T | null {
    const [version, ivValue, ciphertextValue, tagValue, extra] = ticket.split(".");
    if (version !== TICKET_VERSION || !ivValue || !ciphertextValue || !tagValue || extra !== undefined) return null;
    try {
      const iv = Buffer.from(ivValue, "base64url");
      const ciphertext = Buffer.from(ciphertextValue, "base64url");
      const tag = Buffer.from(tagValue, "base64url");
      if (iv.byteLength !== IV_BYTES || tag.byteLength !== 16 || ciphertext.byteLength === 0) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const envelope = JSON.parse(plaintext) as Partial<Envelope<T>>;
      if (envelope.version !== 1 || envelope.kind !== expectedKind || envelope.payload === undefined) return null;
      return envelope.payload;
    } catch {
      return null;
    }
  }
}
