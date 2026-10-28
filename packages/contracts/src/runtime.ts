import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const hashBytes = (value: string | Uint8Array) => bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
export function randomUUID(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function encodeBase64(value: Uint8Array): string {
  let text = '';
  for (let index = 0; index < value.length; index += 8192) text += String.fromCharCode(...value.subarray(index, index + 8192));
  return btoa(text);
}
