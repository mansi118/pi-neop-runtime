/**
 * ACP broker — sign/verify/route signed envelopes (§2.1). Uses an HMAC stand-in
 * for Ed25519 so it is exercisable without key management; interface matches the
 * live signer.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export class ACPBroker {
  private secret: Buffer;
  sent: any[] = [];

  constructor(_mode = "unit", secret = "dev-acp-key") {
    this.secret = Buffer.from(secret);
  }

  private sig(payload: unknown): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(payload)).digest("hex");
  }

  sign(capability: string, payload: unknown): any {
    const envelope: any = { capability, payload, ts: Math.floor(Date.now() / 1000) };
    envelope.sig = this.sig({ capability, payload });
    this.sent.push(envelope);
    return envelope;
  }

  verify(envelope: any): boolean {
    const expected = this.sig({ capability: envelope.capability, payload: envelope.payload });
    const a = Buffer.from(expected);
    const b = Buffer.from(envelope.sig ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
