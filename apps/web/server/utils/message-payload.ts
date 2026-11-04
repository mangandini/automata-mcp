/**
 * What is inside a stored WhatsApp message payload, and what kind of attachment
 * it is. Pure: no Nitro auto-imports, no `#shared`/`~` aliases, only erasable
 * TypeScript, so a plain `node` can load it and the dev check scripts do.
 *
 * Two callers share the unwrapping on purpose. `chats.ts` decides what a row
 * *says* (preview, edits, control records); the media tool decides what a row
 * *is* (which attachment to download). Both must peel the same wrappers or an
 * album child would read as text in one and as a missing attachment in the other.
 */

export type JsonRecord = Record<string, any>

/** `ProtocolMessage.Type.MESSAGE_EDIT` — the only subtype carrying readable content. */
export const PROTOCOL_MESSAGE_EDIT = 14

/**
 * Transparent `FutureProofMessage` wrappers: `{ message: Message }` and nothing
 * else.
 *
 * Baileys' `normalizeMessageContent` unwraps this shape, but the rc.9 Evolution
 * 2.3.7 pins does not know `associatedChildMessage` (added upstream later, PR
 * #1874) — and `prepareMessage` types a row with `getContentType()` on the
 * *raw*, un-normalized payload regardless, so the wrapper name is what reaches
 * us as `messageType`. Official WhatsApp clients produce these for album media
 * and for a caption edit; Baileys' own album sender does not, which is why they
 * went unnoticed until a caller reported empty rows.
 *
 * `ephemeralMessage` and the `viewOnceMessage*` family are deliberately absent.
 * They are transparent wrappers too, but unwrapping a view-once photo to a bare
 * `[image]` presents it as an ordinary photo, which it is not — doing that
 * honestly needs its own marker, and that is a separate decision. The media
 * reader opts into `ephemeralMessage` alone (see `unwrapPayload`): there a
 * disappearing-messages chat wraps every attachment, and view-once stays out.
 */
const WRAPPER_KEYS = ['associatedChildMessage', 'editedMessage', 'documentWithCaptionMessage'] as const

/**
 * Bounded rather than recursive. The payload is always JSON-derived, so a cycle
 * is not reachable and no visited-set is needed; this only caps an absurdly
 * nested one. Falling out of the loop still wrapped leaves the row reading
 * exactly as it did before this existed: wrapper type, no text.
 */
export const MAX_UNWRAP_DEPTH = 4

export function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

export function idOf(key: unknown): string | undefined {
  const id = asRecord(key)?.id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Baileys' `getContentType`, for an already-decoded payload: the first own key
 * that is `conversation` or *contains* `Message`, minus the one it excludes.
 * `messageContextInfo` deliberately does not match — no capital `M` — which is
 * why a sibling context never shadows real content.
 */
export function contentTypeOf(payload: JsonRecord): string | undefined {
  return Object.keys(payload).find(key =>
    (key === 'conversation' || key.includes('Message')) && key !== 'senderKeyDistributionMessage')
}

/**
 * `protocolMessage.type`, as a number.
 *
 * An absent value means **REVOKE**, not "keep": proto3 omits a zero on the wire,
 * so a deletion arrives carrying no `type` at all. Reading that as "unknown, so
 * keep it" would surface every deletion as an empty message — the bug this
 * exists to fix, restored.
 *
 * It is an integer because Evolution's `deserializeMessageBuffers` rebuilds
 * every nested object as a plain object and so discards protobufjs' name-
 * emitting `toJSON`. The string branch is defensive: a tag bump that restored it
 * would otherwise silently reclassify every edit as noise.
 */
export function protocolSubtype(protocol: JsonRecord): number {
  const raw = protocol.type
  if (raw === undefined || raw === null) return 0
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return Number(raw)
    return raw === 'MESSAGE_EDIT' ? PROTOCOL_MESSAGE_EDIT : -1
  }
  return -1
}

export interface UnwrappedPayload {
  /** WhatsApp control plane (a deletion, a timer change, a key exchange). Nothing to read. */
  noise: boolean
  payload?: JsonRecord
  /** Something was peeled off, so the stored `messageType` names a wrapper, not the content. */
  unwrapped: boolean
  /** The message an edit replaces. */
  editOf?: string
}

/**
 * Peel the wrappers off a stored payload: a `protocolMessage` edit (type 14,
 * which nests the whole edited message), a revoke or any other protocol
 * message (noise), and the transparent `WRAPPER_KEYS`.
 *
 * `ephemeral: true` also peels `ephemeralMessage`. Off by default so that
 * `classifyContent`, which presents rows to the model, keeps reading such a row
 * exactly as it always has; the media reader turns it on because a chat with
 * disappearing messages wraps every attachment in it.
 *
 * Takes the *raw stored* `message`; callers never pre-unwrap, or a revoke would
 * not be seen as one.
 */
export function unwrapPayload(message: unknown, options: { ephemeral?: boolean } = {}): UnwrappedPayload {
  let payload = asRecord(message)
  if (!payload) return { noise: false, unwrapped: false }

  const wrappers: readonly string[] = options.ephemeral ? [...WRAPPER_KEYS, 'ephemeralMessage'] : WRAPPER_KEYS
  let unwrapped = false
  let editOf: string | undefined

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const protocol = asRecord(payload.protocolMessage)
    if (protocol) {
      const edited = protocolSubtype(protocol) === PROTOCOL_MESSAGE_EDIT
        ? asRecord(protocol.editedMessage)
        : undefined
      if (!edited) return { noise: true, unwrapped }
      editOf = idOf(protocol.key) ?? editOf
      payload = edited
      unwrapped = true
      continue
    }

    const wrapped = firstWrapped(payload, wrappers)
    if (!wrapped) break
    payload = wrapped
    unwrapped = true
  }

  return { noise: false, payload, unwrapped, editOf }
}

function firstWrapped(payload: JsonRecord, wrappers: readonly string[]): JsonRecord | undefined {
  for (const key of wrappers) {
    const inner = asRecord(asRecord(payload[key])?.message)
    if (inner) return inner
  }
  return undefined
}

// ---------------------------------------------------------------- media

export type MediaRoute = 'image' | 'pdf' | 'document' | 'unsupported'

export interface MediaClass {
  route: MediaRoute
  /** Which payload key carries the attachment, for the three routes that have one. */
  mediaKey?: 'imageMessage' | 'documentMessage'
  /**
   * Why a row is `unsupported`: the payload type (`audioMessage`,
   * `stickerMessage`, `conversation`, …), `'view-once'`, or `'protocolMessage'`.
   */
  unsupportedType?: string
  /** Lower-cased, parameters dropped (`audio/ogg; codecs=opus` → `audio/ogg`). */
  mimeType?: string
  fileName?: string
  caption?: string
  /** From `fileLength`. Unknown is `undefined`, never 0: a size of 0 would pass every cap. */
  declaredSize?: number
  /** `fileSha256` when stored as exactly 32 bytes; the integrity check for the download. */
  sha256?: Uint8Array
  /** The unwrapped payload — what is sent to Evolution to download. */
  inner: JsonRecord
}

/**
 * Which attachment a stored message carries, and whether the media tool can
 * serve it. Takes the raw stored `message` and unwraps it itself
 * (`ephemeralMessage` included): a revoke must come back `unsupported` /
 * `'protocolMessage'`, which it could not if a caller had already stripped the
 * wrapper to get at a payload.
 *
 * View-once is refused by name rather than served. It is a transparent wrapper
 * like the others, but the sender asked for the picture to be seen once, and a
 * tool that hands it to a model on request is not honouring that.
 */
export function classifyMedia(message: unknown): MediaClass {
  const unwrapped = unwrapPayload(message, { ephemeral: true })
  if (unwrapped.noise) return { route: 'unsupported', unsupportedType: 'protocolMessage', inner: {} }
  const payload = unwrapped.payload
  if (!payload) return { route: 'unsupported', unsupportedType: 'unknown', inner: {} }

  const type = contentTypeOf(payload)
  if (!type) return { route: 'unsupported', unsupportedType: 'unknown', inner: payload }
  if (type.startsWith('viewOnceMessage')) {
    return { route: 'unsupported', unsupportedType: 'view-once', inner: payload }
  }

  const content = asRecord(payload[type])
  if (content?.viewOnce === true) {
    return { route: 'unsupported', unsupportedType: 'view-once', inner: payload }
  }
  if (!content || (type !== 'imageMessage' && type !== 'documentMessage')) {
    return { route: 'unsupported', unsupportedType: type, inner: payload }
  }

  const mimeType = mimeOf(content.mimetype)
  const fileName = nonEmptyString(content.fileName)
  const sha256 = storedBytes(content.fileSha256)

  let route: MediaRoute
  if (type === 'imageMessage') route = 'image'
  // A document whose bytes are a picture is routed as one; the download step
  // re-checks the magic bytes before trusting that (hence "provisional").
  else if (mimeType?.startsWith('image/')) route = 'image'
  else if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName ?? '')) route = 'pdf'
  else route = 'document'

  return {
    route,
    mediaKey: type,
    mimeType,
    fileName,
    caption: nonEmptyString(content.caption),
    declaredSize: declaredSizeOf(content.fileLength),
    sha256: sha256?.length === 32 ? sha256 : undefined,
    inner: payload,
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function mimeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.split(';')[0]!.trim().toLowerCase() || undefined
}

/** `fileLength` is a string or a number depending on where in Evolution's pipeline it was read. */
function declaredSizeOf(value: unknown): number | undefined {
  const size = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : undefined
}

// ---------------------------------------------------------------- bytes

/**
 * Bytes as they sit in a stored message, whichever shape Evolution wrote them in.
 * The expected one first: Evolution rebuilds every nested object as a plain
 * object, so a byte field is `{ "0": 12, "1": 255, … }` (its own download code
 * does `Object.values(mediaKey)`). The others are what a tag bump or a different
 * serialiser could produce; a value that is none of them is `undefined`, never a
 * guess. Length is the caller's business (a SHA-256 must be 32 bytes).
 */
export function storedBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value.length ? value : undefined
  if (typeof value === 'string') return fromBase64(value)
  if (Array.isArray(value)) return fromNumbers(value)

  const record = asRecord(value)
  if (!record) return undefined
  if (record.type === 'Buffer' && Array.isArray(record.data)) return fromNumbers(record.data)

  const keys = Object.keys(record)
  if (!keys.length) return undefined
  // Integer-keyed objects enumerate in ascending order, but make it explicit:
  // the keys must be exactly 0..n-1, or this is not a byte array.
  const bytes: unknown[] = new Array(keys.length)
  for (const key of keys) {
    const at = Number(key)
    if (!/^(0|[1-9]\d*)$/.test(key) || at >= keys.length) return undefined
    bytes[at] = record[key]
  }
  return fromNumbers(bytes)
}

function fromNumbers(values: unknown[]): Uint8Array | undefined {
  if (!values.length) return undefined
  const out = new Uint8Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const n = values[i]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return undefined
    out[i] = n
  }
  return out
}

function fromBase64(text: string): Uint8Array | undefined {
  // Strict alphabet first: `atob` is forgiving about whitespace and would turn
  // arbitrary text into "bytes" that then fail a length check for the wrong reason.
  const body = text.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/_-]+$/.test(body) || body.length % 4 === 1) return undefined
  const binary = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out.length ? out : undefined
}

// ---------------------------------------------------------------- magic bytes

/**
 * The image type the bytes themselves declare, never the one the sender claimed.
 * SVG and HTML are deliberately not here: an image tool that accepts them hands
 * a script-capable document to whatever renders it.
 */
export function detectImageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined {
  const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v)
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map(c => c.charCodeAt(0)))

  if (at(0, 0xFF, 0xD8, 0xFF)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) return 'image/png'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  return undefined
}

/**
 * `%PDF-` inside the first 1024 bytes, which is where readers (and the PDF
 * spec's own tolerance) look: a few producers prefix the header with junk.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2D]
  const last = Math.min(bytes.length, 1024) - marker.length
  for (let i = 0; i <= last; i++) {
    if (marker.every((byte, j) => bytes[i + j] === byte)) return true
  }
  return false
}
