import type { AppInstance } from './app-db'
import type { AuthorFilter } from './evolution-db'
import { distinctSenders } from './evolution-db'
import { evolutionClientForInstance } from './evolution'
import type { GroupPerson } from './mentions'
import { groupPeople, localPartOf, meaningfulName } from './mentions'
import type { McpScope } from './mcp-scope'
import { assertChatAllowed } from './mcp-scope'
import { foldForSearch } from './search-text'

/**
 * Turns the `author` a caller typed ("Juan", "+56 9 …") into a filter the SQL can
 * apply, or into an honest "this is ambiguous" / "nobody like that".
 *
 * Members of a group are mostly not saved contacts, so nothing here consults
 * `contactDirectory()`: names come from the group's own participant list first and
 * from what senders publish as their `pushName` second, both read for the one
 * group asked about.
 */
export type AuthorResolution =
  | { kind: 'ok', filter: AuthorFilter, names: string[], matchedBy: 'participants' | 'pushName' | 'number', note?: string }
  | { kind: 'ambiguous', candidates: string[], note?: string }
  | { kind: 'none', note?: string }

/** Same cap as `distinctSenders`' `LIMIT`; reaching it means the list may have been cut. */
const SENDER_LIMIT = 20

/** How many candidate names an ambiguous answer lists; a roster helps nobody. */
const CANDIDATE_LIMIT = 20

/** Parentheses too: `resolveChatTarget` accepts "(502) 5555-1234" for `jid`, so `author` does. */
const NUMBER_LIKE = /^[+\d\s()-]+$/

function ambiguous(names: string[]): AuthorResolution {
  return {
    kind: 'ambiguous',
    candidates: names.slice(0, CANDIDATE_LIMIT),
    note: names.length > CANDIDATE_LIMIT
      ? `Showing the first ${CANDIDATE_LIMIT} of ${names.length} matching names.`
      : undefined,
  }
}

/**
 * Resolve `author` inside one group.
 *
 * `scope` is checked here against `jid`, though the callers have already run
 * `resolveChatTarget` on it: this function reads participant names and senders
 * of the group, so it must not depend on its caller having remembered. Every
 * name, candidate and note it can produce then comes from a chat the token
 * reaches.
 *
 * Order: participants of the group, then `pushName` as a fallback that is only
 * used when participants found nobody (or could not be asked). The two are never
 * combined — a participant match must not drag in another person whose published
 * name happens to look alike.
 */
export async function resolveAuthor(
  instance: AppInstance,
  scope: McpScope,
  jid: string,
  author: string,
): Promise<AuthorResolution> {
  assertChatAllowed(scope, jid)

  if (!jid.endsWith('@g.us')) {
    throw createError({
      statusCode: 400,
      message: '`author` only works inside group chats. In a one-to-one chat the sender is either the other person or you; use `fromMe` to tell them apart.',
    })
  }

  const typed = author.trim()
  if (!typed) {
    throw createError({ statusCode: 400, message: '`author` must not be empty.' })
  }

  const people = await groupPeople(instance, evolutionClientForInstance(instance), jid)
  const participantsUnavailable = people === undefined
  const unavailableNote = 'The group\'s participant list could not be consulted, so the author was matched by the name its messages were sent under.'

  // A number or a JID: an identity, not a name.
  if (typed.includes('@') || NUMBER_LIKE.test(typed)) {
    // Digits only for a number (leading `+`, spaces and hyphens are formatting);
    // a JID keeps its local part as written. No country-specific rewriting — a
    // value that is not what WhatsApp stored simply matches nothing.
    const identity = typed.includes('@') ? localPartOf(typed) : typed.replace(/[+\s()-]/g, '')
    if (!identity) return { kind: 'none' }

    // The participant row holding this number is what links it to the same person's
    // other forms (a LID, typically), which is how a phone number finds messages
    // stored under the LID.
    const matched = (people ?? []).filter(person => person.identities.some(value => localPartOf(value) === identity))
    const identities = [...new Set([identity, ...matched.flatMap(person => person.identities.map(localPartOf))])]
      .filter(Boolean)

    return {
      kind: 'ok',
      filter: { identities },
      names: matched.map(person => person.name).filter((name): name is string => Boolean(name)),
      // `number` when no member vouched for it: the filter is then the typed value alone.
      matchedBy: matched.length ? 'participants' : 'number',
      note: participantsUnavailable
        ? 'The group\'s participant list could not be consulted, so only the number given was matched, not any other form of it the same person may use.'
        : matched.length === 0
          ? 'No current member of the group has that number; messages sent under it were searched anyway (it may be someone who left).'
          : undefined,
    }
  }

  const needle = foldForSearch(typed).trim()
  // Nothing left once accents and marks are folded away (a lone combining mark):
  // `includes('')` would match every named member.
  if (!needle) {
    throw createError({ statusCode: 400, message: '`author` must contain at least one letter or digit.' })
  }

  if (people) {
    const matches = people.filter((person): person is GroupPerson & { name: string } =>
      Boolean(person.name) && foldForSearch(person.name!).includes(needle))

    // Several members contain the name: if exactly one is called exactly that, it is
    // the one asked for ("Rosa" among "Rosa" and "Rosario"). Without this a name
    // that is a prefix of another could never be chosen; "Ros" stays ambiguous.
    const exact = matches.filter(person => foldForSearch(person.name).trim() === needle)
    const chosen = matches.length === 1 ? matches : exact.length === 1 ? exact : undefined

    if (chosen) {
      const [person] = chosen
      return {
        kind: 'ok',
        filter: { identities: [...new Set(person!.identities.map(localPartOf).filter(Boolean))] },
        names: [person!.name],
        matchedBy: 'participants',
        note: matches.length > 1
          ? `Chose the member named exactly "${person!.name}"; other members have names containing it. Use a more specific name or a phone number for someone else.`
          : undefined,
      }
    }
    if (matches.length > 1) {
      return ambiguous(matches.map(person => person.name))
    }
  }

  // Participants gave nobody (or could not be asked): fall back to the name the
  // senders publish. Covers people who left the group, too. The raw trimmed name
  // goes down: the query folds it with the same table it folds `pushName` with.
  const rawSenders = await distinctSenders(instance, { jid, name: typed })
  const senders = rawSenders.filter(sender => meaningfulName(sender.pushName, sender.identity))
  // `none` carries the same note as `ok`: "nobody posted under that name" and
  // "could not ask who is in the group, and nobody posted under that name" are
  // different answers.
  if (senders.length === 0) {
    return { kind: 'none', note: participantsUnavailable ? unavailableNote : undefined }
  }

  // Grouped by folded name: the LID form and the phone form of one person arrive as
  // two identities under one name and must stay one candidate. Two different people
  // who publish exactly the same name cannot be told apart this way — a residual,
  // accepted case, which the note below says out loud.
  const byName = new Map<string, { display: string, identities: Set<string> }>()
  for (const sender of senders) {
    const key = foldForSearch(sender.pushName).trim()
    const entry = byName.get(key) ?? { display: sender.pushName.trim(), identities: new Set<string>() }
    entry.identities.add(sender.identity)
    byName.set(key, entry)
  }

  // Same rule as for participants: one name equal to what was typed wins over
  // names that merely contain it.
  const only = byName.size === 1 ? [...byName.values()][0] : byName.get(needle)
  const outranked = byName.size > 1 && only !== undefined
  if (!only) {
    return ambiguous([...byName.values()].map(entry => entry.display))
  }

  const notes = [
    participantsUnavailable ? unavailableNote : undefined,
    outranked
      ? `Chose the name "${only.display}", which matches exactly; other names also contain it. Use a more specific name or a phone number for someone else.`
      : undefined,
    only.identities.size > 1
      ? `Messages under the name "${only.display}" came from ${only.identities.size} different ids: they were merged. That is usually one person seen under a phone number and an internal id, but it can be several people who share the name.`
      : undefined,
    // Raw count, before the name filter: the SQL cap is what cuts the list. Rows are
    // ordered by name, so the cut can hide a second, different name ("Rosario" after
    // many "Rosa" rows) and turn an ambiguous case into a confident one.
    rawSenders.length >= SENDER_LIMIT
      ? 'Many senders matched that name and only the first 20 were considered: another person with a similar name may also match, and some of this person\'s messages may be missing.'
      : undefined,
  ].filter((note): note is string => Boolean(note))

  return {
    kind: 'ok',
    filter: { identities: [...only.identities] },
    names: [only.display],
    matchedBy: 'pushName',
    note: notes.length ? notes.join(' ') : undefined,
  }
}
