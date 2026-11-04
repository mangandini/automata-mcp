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
function buildSqlFold(): { from: string, to: string, map: Map<string, string> } {
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
 * The same table as `SQL_FOLD_FROM`/`SQL_FOLD_TO`, cut into stages by how common
 * the characters are, for the SQL side to apply cheapest-first.
 *
 * Why. `translate` takes time proportional to (characters in the text) x (length
 * of FROM), because every character of the text is compared against FROM — and
 * nearly all of them, the plain ones, are compared against all of it. With the
 * whole table (about 440 characters) that was ~100 µs per message: searching a
 * 74,000-message account spent 7 of its 8.5 seconds folding. A regex character
 * class costs almost nothing per character, so the SQL first asks "does this
 * text contain anything the table maps?" — most messages do not — and, when it
 * does, runs only as much of the table as the text needs.
 *
 * Stage 0 is what Spanish needs, stage 1 the rest of the Latin-1 letters
 * (Portuguese, French, Italian, German...), stage 2 everything else, plus the
 * combining marks, which have no counterpart and so are deleted. The stages
 * partition `SQL_FOLD_FROM`; they are applied in order, one `translate` each,
 * which is the same function as the single `translate` over the whole table
 * provided no stage writes a character a later stage would rewrite — asserted
 * below, at load, rather than assumed. `remainder` is a regex character class
 * of the characters the stages after this one handle: a text that does not match
 * it needs no later stage. Empty for the last stage, which has none after it.
 */
const SQL_FOLD_CORE = 'áéíóúüñÁÉÍÓÚÜÑ'

function buildSqlFoldStages(): { from: string, to: string, remainder: string }[] {
  const from: string[][] = [[], [], []]
  const to: string[][] = [[], [], []]
  const letters = [...SQL_FOLD_FROM].slice(0, [...SQL_FOLD_TO].length)
  const marks = [...SQL_FOLD_FROM].slice(letters.length)
  letters.forEach((c, i) => {
    const stage = SQL_FOLD_CORE.includes(c) ? 0 : c.codePointAt(0)! < 0x100 ? 1 : 2
    from[stage]!.push(c)
    to[stage]!.push([...SQL_FOLD_TO][i]!)
  })
  from[2]!.push(...marks)

  const stages = from.map((f, k) => ({
    from: f.join(''),
    to: to[k]!.join(''),
    remainder: k === from.length - 1 ? '' : `[${from.slice(k + 1).flat().join('')}]`,
  }))

  // Fail at load, not in a query: a stage must never emit a character that a
  // later stage maps, or two translates would fold twice what one folds once.
  // A character class built from the table must also not contain anything that
  // is special inside one.
  for (let k = 0; k < stages.length; k++) {
    for (const out of to[k]!) {
      if (from.slice(k + 1).some(later => later.includes(out))) {
        throw new Error(`SQL fold stage ${k} writes ${out}, which a later stage rewrites`)
      }
    }
  }
  if (/[\]\\^\-[]/.test(SQL_FOLD_FROM)) throw new Error('SQL fold table holds a character special in a regex class')
  return stages
}

export const SQL_FOLD_STAGES = buildSqlFoldStages()

/** A regex character class matching any character the table maps or deletes. */
export const SQL_FOLD_ANY = `[${SQL_FOLD_FROM}]`

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
