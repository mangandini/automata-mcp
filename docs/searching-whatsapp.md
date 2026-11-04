# Searching WhatsApp from Claude

How to find things in a WhatsApp connection with `search-messages` and
`read-messages`, what each argument does, and where an empty answer does not
mean "nothing was said". Everything here describes what the tools do today; the
tool descriptions Claude sees carry the same rules in shorter form. For the
database side (why messages are read from Evolution's Postgres, deduplication,
the optional read-only role) see [WhatsApp connections](whatsapp.md). All names,
numbers and messages below are invented.

Both tools are read-only, bound to the one account the connector token was issued
for, and limited to the chats in the token's scope (see
[Scoping a token](using-automata.md#scoping-a-token)). They cover the history
imported when the account was paired as well as everything since.

## Finding a message by what it says

`search-messages` returns matches newest first, across every chat the token can
see, or inside one chat when `jid` is given.

```json
{ "query": "cotizacion fogon", "jid": "+15550000001", "since": "2026-03-01" }
```

- **Accents and case are ignored.** `jose` finds "José", `fogon` finds "FOGÓN".
  A word is matched anywhere inside a message (it is a substring match, not a
  whole-word match).
- **Every word must appear, unless you say otherwise.** Words are separated by
  spaces; `match: "all"` (the default) requires all of them in the same message,
  `match: "any"` finds messages containing at least one. There are no quoted
  phrases: `"hello world"` is two words.
- **File names and captions are searched too.** A document's file name or title
  (`presupuesto-marzo.xlsx`) and a photo or video caption count as message text,
  so `xlsx` finds spreadsheets by name. For such a hit, `text` is the caption if
  there is one, otherwise the file name. The file itself is not downloadable.
- **Narrowing.** `since` / `until` take dates like `2026-03-01` or
  `2026-03-01T12:00:00Z`; `fromMe: true` keeps only what you sent, `false` only
  what you received. Reactions are left out unless `includeReactions: true`
  (the response says `reactionsExcluded: true` when it left them out).
- **Edited messages.** An edit is its own record carrying the new text and
  `editOf`, the id of the message it replaces; the earlier record is still there
  with its old wording. Prefer the edit when the two disagree. An edit WhatsApp
  encrypted for the chat has no readable text and cannot be found by search, so a
  search that finds nothing is not proof the message does not exist.

Unknown arguments are refused with an error naming the key (`Unrecognized key:
"window"`) instead of ignored, so a misspelled `since` or a made-up filter cannot
silently return an unfiltered result.

### A single CJK character is rejected

Every search word must be at least 2 characters long, counted in UTF-16 units,
and must still contain something after accents are folded away. Chinese,
Japanese and Korean words are often a single character, and a single CJK
character is 1 unit, so searching for it alone fails with `The search word "…" is
too short`. Search for a longer word that contains it, or read the chat with
`read-messages` and look. A bare emoji is 2 units and is accepted (add
`includeReactions: true` to find reactions made of that emoji).

### What accent folding does not cover

The folding is done in SQL with a fixed table covering the Latin-1 and Latin
Extended-A/B letters (U+00C0 to U+024F) plus combining marks. Inside that range
`ñ`, `ü`, `ç`, `ã`, `ő`, `ă`, `ơ` and similar all fold. Outside it nothing is
folded:

- Vietnamese letters stored as single characters outside that range (`ạ`, `ả`,
  `ấ`, `ế`, `ệ`…) are **not** folded: typing `tieng viet` will not find
  "tiếng việt". Type the word with its accents as written. The same applies to
  other extended-Latin, Greek and Cyrillic accents (Greek tonos, Cyrillic `й`:
  `мои` does not find `мой`).
- Letters that are not accented forms of another letter are never folded: `ø`,
  `đ`, `ł`, `ß`, `æ`, `œ`. Typing `l` does not find `ł`.

If a search for an accented word finds nothing, retry with the word exactly as
people write it before concluding it was never said.

## Searching one chat by phone number

`jid` accepts either a chat id from `list-chats` (anything containing `@`, used
as is after the scope check) or a phone number.

- **Type the number in the form WhatsApp stores:** country code first, digits
  only. A leading `+`, spaces, hyphens and parentheses are stripped (`+1 555-000-0001`
  and `15550000001` are the same input), but nothing else is rewritten: a local
  format without a country code, or with a trunk prefix, is not completed for you.
  The number is resolved through WhatsApp via Evolution, never by rules in this
  app. A number with no WhatsApp account is an explicit error (a 404-class refusal) for an unrestricted
  token, and the generic "No accessible WhatsApp chat was found for that number"
  for a chat-scoped token (so a scoped token cannot use it to probe which numbers
  exist). If the WhatsApp account is unreachable the answer is a 503-class error,
  not an empty result.
- **One number can be several chats.** WhatsApp stores a person under their phone
  number (`…@s.whatsapp.net`) and sometimes under an internal id (`…@lid`). The
  tool resolves the number, then adds the other forms the stored history links to
  it, drops any form outside the token's scope without naming it, and tells you
  which forms it covered: `chatsSearched` in `search-messages`, `chatsRead` in
  `read-messages`.
- **The `@lid` caveat.** The link between a phone number and its `@lid` chat is
  recorded only by live traffic after pairing, not on history imported at pairing.
  So a chat that exists only as an `@lid` may not be reachable by number, and a
  call that does return messages can still be missing an unlinked `@lid` form
  with no warning: check `chatsRead` / `chatsSearched` to see which forms were
  actually covered. When a number-addressed call returns nothing, the `note` says
  so and points at `list-chats`: search the chat list by the person's name, take the `jid` it
  returns (it may end in `@lid`), and use that. An empty result for a number is
  "not found under the forms I could link", not "no such conversation".

## Messages by one person in a group

`author` (in both tools) keeps only what one member of a **group** sent. It takes a
name or a phone number and needs the group's `jid`.

```json
{ "jid": "120363000000000001@g.us", "author": "Ana", "since": "2026-03-01" }
```

- **Groups only.** In a one-to-one chat `author` is refused: the sender is
  the other person or you, and `fromMe` tells them apart. In `search-messages`
  `author` also requires `jid`, and cannot be combined with `fromMe: true`. There
  is no author search across the whole account.
- **Names come from the group, not your address book.** Group members are mostly
  not saved contacts, so the name is matched (accents and case ignored, substring)
  against the group's participant list first. Only if that finds nobody, or the
  list could not be fetched, are the names senders publish on their messages
  (their `pushName`) used. The two are never combined. The `pushName` route also
  finds people who have left the group. The response says how it matched in
  `authorResolved: { names, matchedBy }` where `matchedBy` is `participants`,
  `pushName` or `number`.
- **A number works too.** Digits only after stripping `+`, spaces, hyphens and
  parentheses, again with no local rewriting; a value that is not what WhatsApp
  stored matches nothing. If a current member has that number, their other ids (an
  `@lid`, typically) are included; if none does, the number is searched as typed
  and the `note` says so.
- **Two people with the same name.** If the name matches more than one person the
  tool searches nothing and returns `authorCandidates` (names as the group shows
  them, at most 20, with a `note` when cut) so Claude can ask which one is meant.
  One exception: if exactly one candidate's whole name equals what you typed
  (ignoring accents and case), that one is chosen and the `note` says so. "Rosa"
  picks Rosa even though "Rosario" also contains it; "Ros" stays ambiguous. Two
  members with exactly the same name also stay ambiguous, and the candidate list
  then shows that name twice: use a phone number to choose.
- **Residual risk.** On the `pushName` route two different people who publish
  exactly the same name cannot be told apart from the messages alone. Ids are
  grouped by name, so when one name shows up under several ids the tool merges
  them (a phone id and an `@lid` of one person look just like two people) and says
  so in the `note`; it cannot tell you which it was. The route also looks at only
  the first 20 matching senders and says when that cap was hit, since another
  similarly named person, or some of this person's messages, may then be missing.
  When it matters, give a phone number.
- **Author alone omits captionless media.** Without a `query`, `search-messages`
  lists only messages that have text, a caption or a file name. A photo, voice
  note or sticker with no caption has nothing to match and is not listed (the
  `note` says so). To see everything one person sent, media included, use
  `read-messages` with `author`.

## Walking a long result

Both tools return one page and say so. Never treat a page as the whole answer
while `hasMore` is `true`.

| | `search-messages` | `read-messages` |
|---|---|---|
| Page size | `limit` 1 to 100, default 20 | `limit` 1 to 200, default 50 |
| Next page | `page: nextPage` | `page: nextPage` |
| Range bound | `until` is always pinned (to now if you gave none) | `until` is pinned once you pass `since` |
| Echoed back as | `window` (`since` if given, and `until`) | `window` |
| Count | `totalMatching` | `totalMatching`, `totalPages` |

**The page + until pattern.** Results come from live SQL, newest first, so a
message arriving between two calls would shift every later page. To prevent that
the first response pins the upper bound of the range and returns it as
`window.until`. (`read-messages` pins it only when you pass `since`; for a plain
newest-first read with no date range there is no `window`, so pass an `until` of
your own on the first call if you intend to page through a busy chat.) To get the next page, call again with the **same arguments**,
`page` set to `nextPage` and `until` set to `window.until`. Pass back `until`, not
`window`: `window` is output only and would be rejected as an unknown argument.
The `note` of a `search-messages` response with `hasMore` spells out the exact
call. Keep going until `hasMore` is `false`. For `search-messages`, `totalMatching`
counts distinct matching messages, so the `count`s of all pages should add up to
it with no repeated ids (this is the intended invariant of the paging design;
check it against your own deployment if you rely on it). `truncated` is kept for older
callers and always equals `hasMore`.

`hasMore` comes from fetching one row more than the page, never from the total, so
a full last page may cost one extra call that returns nothing.

`read-messages` also reports `covered`, the span of time the page actually holds:
for a truncated `since` range it is narrower than the one you asked for, and the
old end of the range is what is missing. `totalMatching` there counts WhatsApp
control records (deletions, disappearing-message timer changes, key exchanges)
that are left out of the messages; `protocolMessagesExcluded` says how many were
dropped from the page, so `totalMatching` can exceed what you receive.

## Context around a message

`read-messages` with `around` returns the messages surrounding one message
instead of a page. Take the hit's `jid` and `id` from `search-messages`:

```json
{ "jid": "15550000001@s.whatsapp.net", "around": "3EB0EXAMPLEID", "before": 5, "after": 5 }
```

- `before` and `after` are 0 to 50 and default to 10 each. The window comes back
  in chronological order, the requested message flagged `target: true`, with
  `hasMoreBefore` and `hasMoreAfter`. Reactions are left out of the neighbours
  (never out of the message you named) unless `includeReactions` is set.
- `around` cannot be combined with `page` above 1, `since`, `until` or `author`
  (an error), and `before`/`after` need `around`.
- An id that is not in the chat is an error; the id is looked up inside the chat
  you name, never across the account.
- Control records among the neighbours are skipped, so the window can hold fewer
  than `before` / `after` readable messages; `protocolMessagesExcluded` and the
  `note` say when that happened.
- **One stored form only.** If you address the chat by phone number and the
  history holds it under more than one form (see the `@lid` caveat), the window is
  built from the first form that contains the message, and `chatsRead` names that
  single form. Messages the same conversation has under its other form are not
  part of the window. Pass the `jid` the hit came back with to be exact.

## Opening an attachment

A hit that is a file shows its name in the text and its `id`; the answer is often
inside the file (a quote, a bank transfer screenshot). If the token has
`get-message-media` ticked (it is off by default, see
[WhatsApp connections](whatsapp.md#attachments-get-message-media)), pass that id
to it: images come back as pictures, PDFs as text, and every call also returns a
download link (1 hour, 20 downloads, no sign-in) to give to the person who wants
the file. Spreadsheets and Word files are not read, only linked. Asking for the
same attachment twice downloads it from WhatsApp again unless it was fetched in
the last ten minutes.

## When an answer is empty or looks short

- A search that finds nothing is only "nothing found" if it also did not carry a
  `note`, a `truncated`/`hasMore` flag or an `authorCandidates` list. Read the
  note first.
- Check spelling of accents outside Latin-1/Latin Extended-A/B, and a single CJK
  character, as above.
- An account paired before full-history sync was enabled holds only what arrived
  since; see [Importing existing history](whatsapp.md#importing-existing-history).
- Encrypted edits cannot be read or searched; reactions and control records are
  left out on purpose and counted (`reactionsExcluded`, `protocolMessagesExcluded`).
