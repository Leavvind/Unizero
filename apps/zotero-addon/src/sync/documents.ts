import { compareCodeUnits } from "../utils/ordering";
import {
  SYNC_DOCUMENT_SCHEMA,
  type SyncDocument,
  type SyncNamespace,
  type SyncNamespaceName,
} from "./types";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(stableValue); }
  if (!value || typeof value !== "object") { return value; }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      // Code-unit order, never locale order: this key order is what every pack
      // ID and checksum is computed over, and it must not vary by device.
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function stableJSONString(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Synchronous SHA-256 avoids a Node dependency and works in privileged Firefox. */
function sha256(text: string): string {
  const source = new TextEncoder().encode(text);
  const length = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = source.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(length - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (
        words[index - 16] + s0 + words[index - 7] + s1
      ) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^
        rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (
        h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]
      ) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^
        rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(
    hash,
    (value) => value.toString(16).padStart(8, "0"),
  ).join("");
}

/** Content-addressed packs and checkpoints use canonical JSON plus SHA-256. */
export function syncChecksum(value: unknown): string {
  return sha256(stableJSONString(value));
}

export function syncDocumentChecksum(document: SyncDocument): string {
  return syncChecksum({
    syncSchema: document.syncSchema,
    namespace: document.namespace,
    id: document.id,
    schema: document.schema,
    scope: document.scope,
    updatedAt: document.updatedAt,
    payload: document.payload,
  });
}

export function parseSyncDocument(body: string): SyncDocument {
  const document = JSON.parse(body) as SyncDocument;
  if (
    document?.syncSchema !== SYNC_DOCUMENT_SCHEMA ||
    typeof document?.namespace !== "string" ||
    typeof document?.id !== "string" ||
    typeof document?.schema !== "number" ||
    typeof document?.updatedAt !== "number" ||
    typeof document?.deviceID !== "string" ||
    !document?.scope ||
    typeof document.scope.id !== "string"
  ) {
    throw new Error("Unsupported or invalid sync document");
  }
  return document;
}

function sameDocument(left: SyncDocument, right: SyncDocument): boolean {
  return syncDocumentChecksum(left) === syncDocumentChecksum(right);
}

/**
 * Existing Project objects already carry object-level updatedAt timestamps and
 * tombstones. LWW is therefore deterministic; deviceID breaks equal-time ties.
 */
export function latestWriteWinsNamespace<T>(
  name: SyncNamespaceName,
  currentSchema: number,
  validatePayload: (payload: unknown) => T,
): SyncNamespace<T> {
  const validate = (document: SyncDocument<unknown>): SyncDocument<T> => {
    if (
      document.syncSchema !== SYNC_DOCUMENT_SCHEMA ||
      document.namespace !== name ||
      document.schema !== currentSchema
    ) {
      throw new Error(
        `Unsupported ${name} sync schema: ${document.schema}`,
      );
    }
    return { ...document, payload: validatePayload(document.payload) };
  };
  return {
    name,
    currentSchema,
    validate,
    migrate: validate,
    merge(local, remote, context) {
      if (sameDocument(local, remote)) { return local; }
      if (local.updatedAt !== remote.updatedAt) {
        return local.updatedAt > remote.updatedAt ? local : remote;
      }
      if (local.deviceID !== remote.deviceID) {
        return syncChecksum(local.payload) >= syncChecksum(remote.payload)
          ? local
          : remote;
      }
      return {
        ...local,
        payload: validatePayload(local.payload),
        updatedAt: context.now,
        deviceID: context.deviceID,
      };
    },
  };
}
