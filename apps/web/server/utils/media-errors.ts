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

export class MediaError extends Error {
  kind: MediaFailureKind
  /** Only for `cooldown`: how long until the same message may be asked again. */
  retryAfterSec?: number
  /** Evolution's own text, kept for the server log; never shown to the model. */
  evolutionText?: string

  constructor(kind: MediaFailureKind, message: string, extra?: { retryAfterSec?: number, evolutionText?: string }) {
    super(message)
    this.name = 'MediaError'
    this.kind = kind
    this.retryAfterSec = extra?.retryAfterSec
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

/**
 * The reason text out of whatever an error carries: Evolution's JSON body
 * (`{ response: { message: ['…'] } }`), a plain `{ message }`, a bare string,
 * or an ofetch error that wraps the body in `data`. `''` when there is none.
 */
export function evolutionErrorText(body: unknown): string {
  if (typeof body === 'string') return body
  if (typeof body !== 'object' || body === null) return ''
  const o = body as Record<string, unknown>
  const response = o.response
  if (typeof response === 'object' && response !== null) {
    const inner = firstString((response as Record<string, unknown>).message)
    if (inner) return inner
  }
  const own = firstString(o.message)
  if (own) return own
  return evolutionErrorText(o.data)
}

/**
 * `timedOut` is our own 30 s timer and wins over any text. The CDN's 404/410
 * only ever appears inside Evolution's 400 text, so the status code of the
 * HTTP answer is not used: it is always 400.
 */
export function classifyEvolutionFailure(input: { status?: number, text?: string, timedOut?: boolean }): MediaFailureKind {
  if (input.timedOut) return 'timeout'
  const text = input.text ?? ''
  if (/message not found/i.test(text) || /not of the media type/i.test(text)) return 'internal'
  if (/status code (404|410)\b/i.test(text)) return 'expired'
  return 'unknown'
}

const MESSAGES: Record<MediaFailureKind, { status: number, message: string }> = {
  expired: { status: 404, message: 'WhatsApp no longer has this file. Ask the sender to send it again.' },
  timeout: { status: 504, message: 'WhatsApp did not answer within 30 seconds, so the file may no longer be available. Try again later.' },
  cooldown: { status: 429, message: 'This file was requested a moment ago and WhatsApp did not answer. Wait about two minutes before asking for it again.' },
  busy: { status: 503, message: 'The server is busy with other downloads. Try again in a few seconds.' },
  'too-large': { status: 413, message: 'The file is larger than this connector will handle.' },
  'hash-mismatch': { status: 502, message: 'The downloaded file did not match its checksum, so it was discarded. Try again, or ask the sender to send it again.' },
  empty: { status: 502, message: 'WhatsApp returned no content for this message.' },
  internal: { status: 500, message: 'The file could not be fetched because of an internal error. It has been logged on the server.' },
  unknown: { status: 502, message: 'WhatsApp could not deliver this file and gave no recognisable reason. Try again later.' }
}

const DISCONNECTED_CAUSES: ReadonlySet<MediaFailureKind> = new Set(['expired', 'timeout', 'unknown'])

/**
 * The answer for the model, with the HTTP status the link route uses. The
 * account state is appended only where a dropped session is a plausible cause;
 * for "busy" or "too large" it would be noise that points the wrong way.
 */
export function mediaFailureMessage(kind: MediaFailureKind, accountState?: string): { status: number, message: string } {
  const { status, message } = MESSAGES[kind]
  if (DISCONNECTED_CAUSES.has(kind) && accountState !== undefined && accountState !== 'open') {
    return { status, message: `${message} The WhatsApp account is currently disconnected (state: ${accountState}), which is the likely cause.` }
  }
  return { status, message }
}
