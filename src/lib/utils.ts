import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Standard base64 for file bytes, in chunks.
 *
 * `btoa` takes a binary string, so the bytes have to be fed in small batches;
 * one `String.fromCharCode(...bytes)` on a 20 MB file overflows the argument
 * limit. Used by every composer that uploads attachments.
 */
export function encodeFileBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    )
    for (const byte of chunk) binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
