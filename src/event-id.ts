import { randomBytes } from "node:crypto";

let lastMs = 0;
let counter = 0;

/**
 * A UUIDv7 (RFC 9562): a 48-bit millisecond timestamp, then random bits. Time order matters
 * because a batch lands under one database insert time, so the id is what still orders a
 * session's rows. Within one millisecond a 12-bit counter in `rand_a` keeps ids from the same
 * process increasing; across processes, ids in the same millisecond order arbitrarily.
 */
export function newEventId(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    counter = randomBytes(2).readUInt16BE() & 0x7ff; // start low so the counter has headroom
  } else {
    counter += 1;
    if (counter > 0xfff) {
      // Out of counter space: borrow the next millisecond rather than repeat or go backwards.
      lastMs += 1;
      counter = 0;
    }
  }

  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
