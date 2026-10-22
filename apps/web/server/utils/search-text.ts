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
 * Whether `needle` appears, folded, inside any of `fields`. An empty or
 * blank needle matches everything (no filter asked for); an undefined field
 * never matches, so a missing phone number can't satisfy a search.
 */
export function matchesSearch(needle: string | undefined, ...fields: (string | undefined)[]): boolean {
  const folded = foldForSearch((needle ?? '').trim())
  if (!folded) return true
  return fields.some(field => field !== undefined && foldForSearch(field).includes(folded))
}
