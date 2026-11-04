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
function buildSqlFold(): { from: string; to: string; map: Map<string, string> } {
  let from = ''
  let to = ''
  const map = new Map<string, string>()
  for (let code = 0x00c0; code <= 0x024f; code++) {
    const c = String.fromCodePoint(code)
    const folded = foldForSearch(c)
    if ([...folded].length === 1 && folded !== c) {
      from += c
      to += folded
      map.set(c, folded)
    }
  }
  for (let code = 0x0300; code <= 0x036f; code++) from += String.fromCodePoint(code)
  return { from, to, map }
}

const SQL_FOLD = buildSqlFold()
export const SQL_FOLD_FROM: string = SQL_FOLD.from
export const SQL_FOLD_TO: string = SQL_FOLD.to

/**
 * A needle folded exactly the way the SQL `translate(body, FROM, TO)` folds the
 * stored text: lowercase, then the same table, with combining marks dropped.
 *
 * `foldForSearch` is wider than the table (it also strips the accent of `й`, a
 * Greek tonos, Vietnamese vowels — characters the SQL side leaves alone), so a
 * needle bound for SQL must not use it: "мой" would become "мои" and never match
 * the stored "мой". Whatever the table does not cover is left alone on both sides.
 * Use this for every needle compared against `translate`d text; keep
 * `foldForSearch` for in-memory matching, where both sides go through it.
 */
export function foldForSql(text: string): string {
  let out = ''
  for (const char of text.toLowerCase()) {
    const code = char.codePointAt(0)!
    if (code >= 0x0300 && code <= 0x036f) continue
    out += SQL_FOLD.map.get(char) ?? char
  }
  return out
}

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
