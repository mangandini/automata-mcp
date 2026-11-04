/**
 * What goes wrong when a WhatsApp attachment is fetched, and what the model is
 * told about it. Pure (no imports), so a plain `node` loads it and the tool and
 * the public link route share one vocabulary.
 *
 * Evolution 2.3.7 answers every failure of `getBase64FromMediaMessage` as a
 * 400 with the reason as text in `response.message[0]`, so the only way to tell
 * an expired file from a bug is to read that text. Two of its texts
 * (`Message not found`, `not of the media type`) cannot happen when the caller
 * sends the whole, already-checked message: if one shows up the bug is ours,
 * not WhatsApp's, so it is classified apart (`internal`) for the caller to log,
 * and the model gets a generic answer instead of a wrong "ask them to resend".
 */

export type MediaFailureKind =
  | 'expired'
  | 'timeout'
  | 'cooldown'
  | 'busy'
  | 'too-large'
  | 'hash-mismatch'
  | 'empty'
  | 'internal'
  | 'unknown'

/** The failures that put a message on the cooldown: asking again at once would only repeat them. */
export type CooldownCause = 'timeout' | 'expired' | 'unknown'
export function isCooldownCause(kind: MediaFailureKind): kind is CooldownCause {
  return kind === 'timeout' || kind === 'expired' || kind === 'unknown'
}

export class MediaError extends Error {
  kind: MediaFailureKind
  /** `cooldown` and `busy`: how long until asking again is worth it. */
  retryAfterSec?: number
  /** Only for `cooldown`: the failure that started it. */
  cooldownCause?: CooldownCause
  /** Evolution's own text, kept for the server log; never shown to the model. */
  evolutionText?: string

  constructor(kind: MediaFailureKind, message: string, extra?: { retryAfterSec?: number, cooldownCause?: CooldownCause, evolutionText?: string }) {
    super(message)
    this.name = 'MediaError'
    this.kind = kind
    this.retryAfterSec = extra?.retryAfterSec
    this.cooldownCause = extra?.cooldownCause
    this.evolutionText = extra?.evolutionText
  }
}

function firstString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string') return item
  }
  return ''
}

function textOfBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (typeof body !== 'object' || body === null) return ''
  const o = body as Record<string, unknown>
  const response = o.response
  if (typeof response === 'object' && response !== null) {
    const inner = firstString((response as Record<string, unknown>).message)
    if (inner) return inner
  }
  return firstString(o.message)
}

/**
 * The reason text out of whatever an error carries: Evolution's JSON body
 * (`{ response: { message: ['…'] } }`), a plain `{ message }`, a bare string,
 * or an ofetch error. The last carries the body in `data` and its own
 * `message` is only `[POST] "url": 400 Bad Request`, so `data` is read first
 * (one level, no recursion). `''` when there is none.
 */
export function evolutionErrorText(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const fromData = textOfBody((body as Record<string, unknown>).data)
    if (fromData) return fromData
  }
  return textOfBody(body)
}

/**
 * `timedOut` is our own 30 s timer and wins over any text. The HTTP status of
 * the answer is not used: it is always 400. What 2.3.7 really sends for a file
 * WhatsApp no longer serves is `Error: Failed to fetch stream from <signed CDN
 * url>` (Baileys rc.9 throws that on any non-OK CDN status, the code is not in
 * the text); the `status code 404|410` form is older. The text can also mean
 * some other CDN failure, which is why the `expired` message says "may have
 * expired". It holds a signed URL: it goes to the server log only, never into
 * anything the model or a link visitor reads.
 */
export function classifyEvolutionFailure(input: { status?: number, text?: string, timedOut?: boolean }): MediaFailureKind {
  if (input.timedOut) return 'timeout'
  const text = input.text ?? ''
  if (/message not found/i.test(text) || /not of the media type/i.test(text)) return 'internal'
  if (/failed to fetch stream from|status code (404|410)\b/i.test(text)) return 'expired'
  return 'unknown'
}

const MESSAGES: Record<MediaFailureKind, { status: number, message: string }> = {
  expired: { status: 404, message: 'This file is no longer available from WhatsApp (it may have expired). Ask the sender to send it again.' },
  timeout: { status: 504, message: 'WhatsApp did not answer within 30 seconds, so the file may no longer be available. Try again later.' },
  cooldown: { status: 429, message: 'This file was requested a moment ago and WhatsApp did not answer. Wait about two minutes before asking for it again.' },
  busy: { status: 503, message: 'The server is busy with other downloads. Try again in a few seconds.' },
  'too-large': { status: 413, message: 'The file is larger than this connector will handle.' },
  'hash-mismatch': { status: 502, message: 'The downloaded file did not match its checksum, so it was discarded. Try again, or ask the sender to send it again.' },
  empty: { status: 502, message: 'WhatsApp returned no content for this message.' },
  internal: { status: 500, message: 'The file could not be fetched because of an internal error. It has been logged on the server.' },
  unknown: { status: 502, message: 'WhatsApp could not deliver this file and gave no recognisable reason. Try again later.' }
}

/**
 * While a message cools down, the answer repeats the failure that started it,
 * because that is still the truth: a file WhatsApp said is gone is not "busy",
 * and one that timed out was not refused. The expired one keeps the advice
 * that helps (ask for it to be sent again).
 */
const COOLDOWN_MESSAGES: Record<CooldownCause, string> = {
  timeout: MESSAGES.cooldown.message,
  expired: 'This file was requested a moment ago and WhatsApp said it is no longer available (it may have expired). Ask the sender to send it again; asking for it here again within about two minutes gets this same answer.',
  unknown: 'This file was requested a moment ago and WhatsApp could not deliver it, giving no recognisable reason. Wait about two minutes before asking for it again.',
}

/** The answer for a message on the cooldown, worded after the failure that started it. */
export function cooldownFailureMessage(cause: CooldownCause = 'timeout'): { status: number, message: string } {
  return { status: MESSAGES.cooldown.status, message: COOLDOWN_MESSAGES[cause] }
}

const DISCONNECTED_CAUSES: ReadonlySet<MediaFailureKind> = new Set(['expired', 'timeout', 'unknown'])
/** States a live read really returned for a session that is not working. */
const DOWN_STATES: ReadonlySet<string> = new Set(['close', 'connecting'])

/**
 * The answer for the model, with the HTTP status the link route uses. The
 * account state is appended only where a dropped session is a plausible cause;
 * for "busy" or "too large" it would be noise that points the wrong way. Only
 * a state actually observed as down is called a disconnect; `unknown` (the live
 * read itself failed) says so instead of asserting one, and anything else is
 * left out. The public link route must NOT pass `accountState`: the public page
 * never reveals the state of the account, only authenticated callers may.
 */
export function mediaFailureMessage(kind: MediaFailureKind, accountState?: string): { status: number, message: string } {
  const { status, message } = MESSAGES[kind]
  if (!DISCONNECTED_CAUSES.has(kind) || accountState === undefined) return { status, message }
  if (DOWN_STATES.has(accountState)) {
    return { status, message: `${message} The WhatsApp account is currently disconnected (state: ${accountState}), which is the likely cause.` }
  }
  if (accountState === 'unknown') return { status, message: `${message} The state of the WhatsApp account could not be read.` }
  return { status, message }
}
