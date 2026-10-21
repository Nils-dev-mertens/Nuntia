/** Attachment data needed to determine whether it is media. */
type MediaItem = { mimeType: string }

/** Hash the actual bytes and keep only one copy of identical media. */
export async function dedupeMediaByHash<T extends MediaItem>(
  items: T[],
  hashOf: (item: T) => Promise<string>,
): Promise<{ items: T[]; failedCount: number }> {
  const hashes = new Array<string | null>(items.length).fill(null)
  const mediaIndices = items.flatMap((item, index) => {
    const mimeType = item.mimeType.trim().toLowerCase()
    return mimeType.startsWith('image/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('video/')
      ? [index]
      : []
  })
  let nextIndex = 0
  let failedCount = 0

  // A small worker pool hashes media concurrently without opening an
  // unbounded number of attachment downloads for a large conversation.
  const workerCount = Math.min(3, mediaIndices.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < mediaIndices.length) {
        const position = nextIndex++
        const itemIndex = mediaIndices[position]
        const item = items[itemIndex]

        try {
          const hash = (await hashOf(item)).trim().toLowerCase()
          if (!hash) throw new Error('Empty media hash.')
          hashes[itemIndex] = hash
        } catch {
          // A failed check leaves this media visible rather than hiding a
          // possibly distinct file. Report failures to the caller.
          failedCount += 1
        }
      }
    }),
  )

  const seenHashes = new Set<string>()
  const unique = items.filter((_, index) => {
    const hash = hashes[index]
    if (typeof hash !== 'string') return true
    if (seenHashes.has(hash)) return false
    seenHashes.add(hash)
    return true
  })

  return { items: unique, failedCount }
}

/** SHA-256 hex digest, usable in browser and server Web Crypto contexts. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
