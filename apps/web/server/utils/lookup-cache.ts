/**
 * A short-lived cache for a lookup that can be unavailable rather than empty.
 *
 * Both Evolution lookups that go through Baileys — a group's subject, a group's
 * participants — share an awkward shape. They are live round trips to WhatsApp,
 * so they are slow and they never answer at all while the account is
 * disconnected; they are asked for repeatedly, because a picker refetches on
 * every open and an MCP client may call `list-chats` in a loop; and their
 * answers change on a human timescale, so a stale one is nearly always right.
 *
 * `chats.ts` and `mentions.ts` had a copy of this each, five constants apiece,
 * with `mentions.ts` documenting its copy as "cached and guarded exactly like
 * `fetchGroups` in `chats.ts`, and for the same reasons" — which is this file's
 * reason to exist, written out longhand.
 *
 * Three behaviours, and each is load-bearing:
 *
 *   serve stale   A failed refresh returns the value we had rather than
 *                 dropping to nothing: a name from a minute ago still beats a
 *                 raw id on screen.
 *   cache the     For a shorter window. `findChats` reads Evolution's database
 *   failure       and keeps answering while the account is disconnected —
 *                 exactly when these cannot succeed — so without this every
 *                 caller would pay the full timeout again.
 *   never throw   A caller must still get its messages back when nobody can be
 *                 named, so `load` reports failure as `undefined` and this
 *                 answers with `empty`.
 */
export interface StaleCacheOptions<T> {
  /** How long a good answer is served for. */
  ttlMs: number
  /** How long a failure is served for, before the lookup is tried again. */
  retryTtlMs: number
  /** Answer when a lookup fails and nothing was cached. Shared, so keep it immutable. */
  empty: T
}

/**
 * Returns the `resolve(key, load)` function to cache behind.
 *
 * `load` must resolve to `undefined` for "could not answer" and to a value for
 * "answered", including an answer that is legitimately empty — the two are not
 * the same and only the caller can tell them apart.
 */
export function staleWhileFailing<T>(options: StaleCacheOptions<T>) {
  const entries = new Map<string, { expiresAt: number, value: T }>()

  return async function resolve(key: string, load: () => Promise<T | undefined>): Promise<T> {
    const cached = entries.get(key)
    if (cached && Date.now() < cached.expiresAt) return cached.value

    const loaded = await load()

    // Values are handed out by identity, never copied: a caller may compare the
    // result with `empty` (`mentions.ts` does, to tell "lookup failed" from
    // "answered with nothing"), so a failed lookup must return that very object.
    if (loaded === undefined) {
      const value = cached?.value ?? options.empty
      entries.set(key, { expiresAt: Date.now() + options.retryTtlMs, value })
      return value
    }

    entries.set(key, { expiresAt: Date.now() + options.ttlMs, value: loaded })
    return loaded
  }
}
