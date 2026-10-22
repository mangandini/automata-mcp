/**
 * Accent- and case-insensitive text matching for the chat and contact
 * searches. Pure and free of Nitro imports so a plain `node` can load it.
 */

/**
 * Lowercase, then decompose (NFD) and drop combining marks, so "José" and
 * "jose" fold to the same string. Typing without accents is how people
 * search on a phone; the stored names keep theirs.
 */
export function foldForSearch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * The same fold, as arguments for SQL `translate(body, FROM, TO)`, so a
 * search that runs in the database matches exactly what `foldForSearch`
 * matches in JS. Built from `foldForSearch` itself at load time (one source,
 * they cannot drift). Both capitalisations are listed so the match does not
 * depend on the database's locale-specific `lower()`. Only characters that
 * fold to a single different character qualify: `ø đ ł ß æ œ` stay out
 * because `foldForSearch` does not fold them either. Combining marks
 * (U+0300-U+036F) go at the end of FROM with no counterpart in TO, which
 * makes `translate` delete them, covering NFD text.
 */
function buildSqlFold(): { from: string; to: string } {
  let from = ''
  let to = ''
  for (let code = 0x00c0; code <= 0x024f; code++) {
    const c = String.fromCodePoint(code)
    const folded = foldForSearch(c)
    if ([...folded].length === 1 && folded !== c) {
      from += c
      to += folded
    }
  }
  for (let code = 0x0300; code <= 0x036f; code++) from += String.fromCodePoint(code)
  return { from, to }
}

const SQL_FOLD = buildSqlFold()
export const SQL_FOLD_FROM: string = SQL_FOLD.from
export const SQL_FOLD_TO: string = SQL_FOLD.to

/**
 * Whether `needle` appears, folded, inside any of `fields`. An empty or
 * blank needle matches everything (no filter asked for); an undefined field
 * never matches, so a missing phone number can't satisfy a search.
 */
export function matchesSearch(needle: string | undefined, ...fields: (string | undefined)[]): boolean {
  const folded = foldForSearch((needle ?? '').trim())
  if (!folded) return true
  return fields.some(field => field !== undefined && foldForSearch(field).includes(folded))
}
