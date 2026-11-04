/**
 * The in-memory pieces the WhatsApp attachment download is built from: a byte
 * cache, a process-wide concurrency gate, a per-message cooldown, in-flight
 * sharing and a rate limiter. Pure (only `./media-errors.ts`), and every
 * factory takes the clock, so a plain `node` checks them without waiting.
 *
 * All of it is per process and lost on restart, on purpose: a cache miss only
 * costs one more download, and nothing here may be the only copy of anything.
 * Several replicas therefore each hold their own cache, gate and limiter, so
 * the limits are per replica.
 *
 * `instanceId` in a cache key is the app's connection id (`AppInstance.id`),
 * never Evolution's, so `evictInstance(instance.id)` matches what the tool and
 * the route insert.
 */

import { MediaError } from './media-errors.ts'

type Clock = () => number

/** NUL cannot occur in a JID or a message id, so the parts cannot run together. */
export function mediaCacheKey(instanceId: string, remoteJid: string, messageId: string): string {
  return `${instanceId}\0${remoteJid}\0${messageId}`
}

export interface MediaCacheEntry {
  bytes: Buffer
  mimeType?: string
}

interface Stored extends MediaCacheEntry {
  expiresAt: number
}

/**
 * Bytes of recently fetched attachments, so a second read of the same file (or
 * the link route after the tool) does not ask WhatsApp again.
 *
 * - TTL is absolute from `set`: a `get` never extends it. A file WhatsApp has
 *   since stopped serving must not stay reachable here because someone keeps
 *   reading it, and the entry is a second copy of private content, so it
 *   should not outlive its welcome.
 * - Eviction is by recency of use, and it makes room only for what fits: an
 *   entry is accepted when `totalBytes + size <= maxBytes` after dropping older
 *   ones (`<=`, so two 25 MB entries fit a 50 MB cap). One larger than the cap
 *   on its own is refused rather than flushing everything for nothing.
 * - `maxBytes <= 0` turns it off.
 */
export function createMediaCache(options: { maxBytes: number, ttlMs: number, now?: Clock }) {
  const { maxBytes, ttlMs } = options
  const now = options.now ?? Date.now
  // A Map iterates in insertion order, so re-inserting on `get` keeps the least
  // recently used entry first.
  const entries = new Map<string, Stored>()
  let totalBytes = 0

  function remove(key: string): void {
    const entry = entries.get(key)
    if (!entry) return
    totalBytes -= entry.bytes.length
    entries.delete(key)
  }

  function dropExpired(at: number): void {
    for (const [key, entry] of entries) if (at >= entry.expiresAt) remove(key)
  }

  return {
    get(key: string): MediaCacheEntry | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (now() >= entry.expiresAt) {
        remove(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return { bytes: entry.bytes, mimeType: entry.mimeType }
    },

    set(key: string, entry: MediaCacheEntry): boolean {
      const size = entry.bytes.length
      if (maxBytes <= 0 || size > maxBytes) return false
      remove(key)
      const at = now()
      // Expired entries go before live ones are pushed out.
      dropExpired(at)
      for (const oldest of entries.keys()) {
        if (totalBytes + size <= maxBytes) break
        remove(oldest)
      }
      entries.set(key, { bytes: entry.bytes, mimeType: entry.mimeType, expiresAt: at + ttlMs })
      totalBytes += size
      return true
    },

    /** Everything of one connection: it was deleted, or its credentials changed. */
    evictInstance(instanceId: string): number {
      const prefix = `${instanceId}\0`
      let removed = 0
      for (const key of [...entries.keys()]) {
        if (!key.startsWith(prefix)) continue
        remove(key)
        removed++
      }
      return removed
    },

    get totalBytes(): number {
      return totalBytes
    }
  }
}

/**
 * Caps how many downloads run at once in this process. A caller that cannot get
 * a slot within `acquireTimeoutMs` is told to come back (`busy`, 10 s) rather
 * than queueing without limit behind slow WhatsApp answers. Slots are handed to
 * waiters in arrival order, and a slot is released when the task settles,
 * thrown or not.
 */
export function createSemaphore(permits: number, acquireTimeoutMs: number) {
  let free = permits
  const waiters: Array<() => void> = []

  function acquire(): Promise<void> {
    if (free > 0) {
      free--
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        // Out of the queue before rejecting, so a slot freed later cannot be
        // handed to someone who has already given up (it would leak).
        const at = waiters.indexOf(grant)
        if (at >= 0) waiters.splice(at, 1)
        reject(new MediaError('busy', 'The server is busy with other downloads.', { retryAfterSec: 10 }))
      }, acquireTimeoutMs)
      waiters.push(grant)
    })
  }

  function release(): void {
    const next = waiters.shift()
    // Hand the slot straight over: `free` is not incremented, so a caller
    // arriving now cannot jump the queue.
    if (next) next()
    else free++
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    }
  }
}

/**
 * Bound for the maps below, which are keyed by something a caller chooses.
 * Trimming goes down to `KEYS_AFTER_TRIM`, not just under the bound, so a flood
 * of new keys pays for a sweep once per thousand keys instead of on every hit.
 */
const MAX_KEYS = 10_000
const KEYS_AFTER_TRIM = 9_000

/**
 * "Do not ask again for a while", per key. Set after Evolution timed out on a
 * message: asking again at once would only pile a second 30 s wait behind the
 * first.
 */
export function createCooldown(ms: number, now: Clock = Date.now) {
  const until = new Map<string, number>()

  function sweep(at: number): void {
    for (const [key, end] of until) if (end <= at) until.delete(key)
    // Still over the bound with nothing expired: oldest insertions go.
    for (const key of until.keys()) {
      if (until.size <= KEYS_AFTER_TRIM) break
      until.delete(key)
    }
  }

  return {
    start(key: string): void {
      const at = now()
      until.delete(key)
      until.set(key, at + ms)
      if (until.size > MAX_KEYS) sweep(at)
    },
    remainingMs(key: string): number {
      const end = until.get(key)
      if (end === undefined) return 0
      const left = end - now()
      if (left > 0) return left
      until.delete(key)
      return 0
    }
  }
}

/**
 * Callers asking for the same thing at the same moment share one promise (and
 * its rejection), so one message is downloaded once however many readers ask.
 * The entry is removed when the promise settles, so a failure is not remembered
 * here (that is the cooldown's job) and a later call starts afresh.
 */
export function createInflight<T>() {
  const running = new Map<string, Promise<T>>()

  return {
    run(key: string, start: () => Promise<T>): Promise<T> {
      const existing = running.get(key)
      if (existing) return existing
      let promise: Promise<T>
      try {
        promise = start()
      } catch (error) {
        // A synchronous throw is a failed start like any other; nothing to
        // register, and the caller sees a rejection, not an exception.
        return Promise.reject(error)
      }
      running.set(key, promise)
      // Two-argument `then`, not `finally`: `finally` returns a new promise
      // that rejects too, with nobody listening to it.
      const clear = () => {
        if (running.get(key) === promise) running.delete(key)
      }
      promise.then(clear, clear)
      return promise
    }
  }
}

/**
 * Sliding-window limit per key. A refused hit is not recorded, so being refused
 * does not extend the wait. The key count is bounded (keys are chosen by
 * callers): expired keys are swept first, then the oldest are dropped, which
 * forgets a limiter's history rather than growing without end. `size` exists
 * for the check script.
 */
export function createRateLimiter(limit: number, windowMs: number, now: Clock = Date.now) {
  const hits = new Map<string, number[]>()

  function sweep(at: number): void {
    for (const [key, times] of hits) {
      if (times.length === 0 || times[times.length - 1]! <= at - windowMs) hits.delete(key)
    }
    for (const key of hits.keys()) {
      if (hits.size <= KEYS_AFTER_TRIM) break
      hits.delete(key)
    }
  }

  return {
    hit(key: string): { allowed: boolean, retryAfterSec: number } {
      const at = now()
      const recent = (hits.get(key) ?? []).filter(time => time > at - windowMs)
      if (recent.length >= limit) {
        hits.delete(key)
        hits.set(key, recent)
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + windowMs - at) / 1000)) }
      }
      recent.push(at)
      hits.delete(key)
      hits.set(key, recent)
      if (hits.size > MAX_KEYS) sweep(at)
      return { allowed: true, retryAfterSec: 0 }
    },
    get size(): number {
      return hits.size
    }
  }
}
