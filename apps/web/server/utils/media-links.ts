import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { toolGranted } from '#shared/tool-optin'
import { appDb, appDbUnavailable, getRow } from './app-db'
import type { AppInstance, AppMediaLink } from './app-db'
import { credentialsForInstance } from './evolution'
import { isTokenLive, selectTokenFacts } from './mcp-auth'
import { instanceKind, isChatAllowed, scopeFromRecord } from './mcp-scope'
import type { McpScope } from './mcp-scope'
import { publicLinkUrl } from './media-safety.ts'
import { authorizesInstance } from './org'

/**
 * Download links for WhatsApp attachments (`get-message-media`), and the one
 * function that decides whether a link may still be used.
 *
 * A link is a third credential path, beside the session cookie and the MCP
 * bearer token, and it is the only one a browser with no session presents. It
 * carries no authority of its own: the row names the MCP token that created it,
 * and every use re-asks whether that token could make the same request now.
 * Revoking the token, unassigning the connection, removing or demoting the
 * member, deleting the connection, un-granting the tool or narrowing the chat
 * scope therefore kills the links it made, with nothing to clean up. Rotating
 * the token's secret does not (the link never held it); a leaked link is good
 * until it expires, an hour at most.
 */

/** A link lives this long from the call that made it. */
export const MEDIA_LINK_TTL_MS = 3_600_000
/** Opening the link, tapping the button twice, a retry after a failure: counted, so a leaked link cannot be hammered. */
export const MEDIA_LINK_MAX_DOWNLOADS = 20
export const MEDIA_TOKEN_PREFIX = 'wamedia_'

/** Prefix + 32 random bytes as base64url (43 characters). Anything else is not one of ours, so never reaches the database. */
const TOKEN_SHAPE = /^wamedia_[\w-]{43}$/

/** Expired rows are kept this long, then deleted by whoever makes the next link. */
const KEEP_EXPIRED = '1 day'

/** The tool that creates links is the tool a link's token must still be granted. */
const LINK_TOOL = 'get-message-media'

/**
 * Whether links can be built at all. They are only ever built from
 * `NUXT_PUBLIC_APP_URL`, never from the request's `Host`, so with it unset the
 * tool still reads attachments and says there is no link.
 */
export function mediaLinksEnabled(): boolean {
  return publicLinkUrl(useRuntimeConfig().public.appUrl, MEDIA_TOKEN_PREFIX) !== undefined
}

function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a link: the token is returned once and only its SHA-256 is stored.
 * Every call makes a new link. Rows expired for over a day are deleted here,
 * so no scheduled task is needed and the table stays bounded by creation rate.
 *
 * Throws when links are disabled; callers check `mediaLinksEnabled()` first
 * and say so in their own words.
 */
export async function createMediaLink(input: {
  instanceId: string
  tokenId: string
  messageId: string
  remoteJid: string
  fileName: string
  mimeType: string
}): Promise<{ url: string, expiresAt: string }> {
  const token = MEDIA_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  // Built before the insert so a disabled setting leaves no row nobody can reach.
  const url = publicLinkUrl(useRuntimeConfig().public.appUrl, token)
  if (!url) throw new Error('media links need NUXT_PUBLIC_APP_URL')

  const sql = await appDb()
  await sql`DELETE FROM app.media_links WHERE expires_at < now() - ${KEEP_EXPIRED}::interval`
  const [row] = await sql<Array<{ expires_at: string }>>`
    INSERT INTO app.media_links (token_hash, instance, token_id, message_id, remote_jid, file_name, mime_type, expires_at)
    VALUES (${hashLinkToken(token)}, ${input.instanceId}, ${input.tokenId}, ${input.messageId},
            ${input.remoteJid}, ${input.fileName}, ${input.mimeType},
            now() + make_interval(secs => ${MEDIA_LINK_TTL_MS / 1000}))
    RETURNING expires_at
  `
  return { url, expiresAt: row!.expires_at }
}

/**
 * The live row for a presented token, or `undefined` for anything that is not
 * one (wrong shape, unknown, expired): the caller answers all of them with the
 * same page. A read that throws is an outage, never "invalid link": telling
 * someone their good link is dead invites them to discard it.
 */
export async function findMediaLinkByToken(token: string): Promise<AppMediaLink | undefined> {
  if (!TOKEN_SHAPE.test(token)) return undefined
  const hash = hashLinkToken(token)
  let link: AppMediaLink | undefined
  try {
    const sql = await appDb()
    ;[link] = await sql<AppMediaLink[]>`
      SELECT * FROM app.media_links WHERE token_hash = ${hash} AND expires_at > now()
    `
  } catch (error) {
    console.error('[media-link] could not look a link up in the app database:', error)
    throw appDbUnavailable(error)
  }
  if (!link) return undefined

  // The lookup above already proves equality; compare explicitly so a change to
  // the query cannot weaken it (same belt as `resolveMcpAuth`).
  const presented = Buffer.from(hash)
  const stored = Buffer.from(link.token_hash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined
  return link
}

/**
 * Take one download out of the link's allowance, before anything is fetched.
 * A conditional write, so two taps racing for the last download cannot both
 * win. `false` = no allowance left, or the link just expired.
 */
export async function claimMediaDownload(linkId: string): Promise<boolean> {
  try {
    const sql = await appDb()
    const rows = await sql`
      UPDATE app.media_links SET downloads = downloads + 1
      WHERE id = ${linkId} AND downloads < ${MEDIA_LINK_MAX_DOWNLOADS} AND expires_at > now()
      RETURNING id
    `
    return rows.length > 0
  } catch (error) {
    console.error(`[media-link] could not claim a download on link ${linkId}:`, error)
    throw appDbUnavailable(error)
  }
}

/**
 * Give back a download claimed for a fetch that failed on WhatsApp's side: the
 * person got nothing and should not pay for it. Never throws. It runs on a path
 * already answering a failure, and a refund that cannot be written costs one
 * unit of a 20-download allowance, which is not worth replacing that answer.
 */
export async function refundMediaDownload(linkId: string): Promise<void> {
  try {
    const sql = await appDb()
    await sql`UPDATE app.media_links SET downloads = GREATEST(downloads - 1, 0) WHERE id = ${linkId}`
  } catch (error) {
    console.error(`[media-link] could not refund a download on link ${linkId}:`, error)
  }
}

/**
 * May this link be used right now? Answers the connection and scope to serve
 * from, or `undefined` (every refusal looks the same to the person holding the
 * link, so the page cannot be used to probe which half failed).
 *
 * The link's own hash, checked by `findMediaLinkByToken`, is the proof that the
 * holder was given this link. What is loaded here is not: the token's facts are
 * read by *id* through `selectTokenFacts`, which authenticates nothing, and the
 * secret behind that token is never seen. So the answer rests on the facts
 * alone, and each of them has to hold:
 *
 *   the token exists and was issued for the connection the link names
 *   not revoked, not expired
 *   its holder still exists, is still in an organization, and still reaches the
 *     connection (`authorizesInstance`, the same rule MCP and the web UI use,
 *     against the org of the connection the TOKEN names)
 *   the connection is WhatsApp and still has Evolution credentials
 *   the token is still granted `get-message-media` (an opt-in tool)
 *   the chat the link was made for is still inside the token's chat scope
 *
 * The first read that throws is an outage and answers 503; "the database is
 * down" must not look like "your link is dead". Each refusal logs which check
 * failed and the link id. It never logs the facts: they carry `token_hash`.
 *
 * Never reads or sets `event.context.mcpAuth` and never sees the browser
 * session: this takes a link row, not a request.
 */
export async function authorizeMediaLink(link: AppMediaLink): Promise<{ instance: AppInstance, scope: McpScope } | undefined> {
  const refuse = (why: string): undefined => {
    console.error(`[media-link] link ${link.id} refused: ${why}`)
    return undefined
  }

  let facts: Awaited<ReturnType<typeof selectTokenFacts>>
  let instance: AppInstance | undefined
  try {
    const sql = await appDb()
    facts = await selectTokenFacts(sql, { id: link.token_id })
    instance = await getRow<AppInstance>('instances', link.instance)
  } catch (error) {
    console.error(`[media-link] could not authorize link ${link.id} against the app database:`, error)
    throw appDbUnavailable(error)
  }

  if (!facts) return refuse('its token no longer exists')
  // The link and the token must name the same connection. The facts' own
  // `assigned` and `member_org` are about the TOKEN's connection, so this is
  // what ties the instance row loaded above to them.
  if (facts.instance !== link.instance) return refuse('its token belongs to another connection')
  if (!isTokenLive(facts)) return refuse('its token is revoked or expired')
  if (!instance) return refuse('its connection no longer exists')
  if (!facts.user_email) return refuse('its token holder no longer exists')
  if (!facts.member_role || !facts.member_org) return refuse('its token holder is in no organization')

  if (!authorizesInstance(
    { role: facts.member_role, orgId: facts.member_org },
    instance.org,
    facts.assigned,
  )) {
    return refuse('its token holder no longer reaches the connection')
  }

  // A kind this build cannot read is refused, never guessed (`instanceKind`
  // has already logged which value it was).
  let kind: string
  try {
    kind = instanceKind(instance)
  } catch {
    return refuse('its connection has an unsupported kind')
  }
  if (kind !== 'whatsapp') return refuse('its connection is not WhatsApp')
  if (!credentialsForInstance(instance)) return refuse('its connection has no Evolution credentials')

  const scope = scopeFromRecord(facts)
  if (!toolGranted(scope, LINK_TOOL)) return refuse(`its token is no longer granted ${LINK_TOOL}`)
  if (!isChatAllowed(scope, link.remote_jid)) return refuse('its chat is outside its token\'s scope')

  return { instance, scope }
}
