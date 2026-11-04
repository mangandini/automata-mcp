/**
 * Shrinks a WhatsApp image to something that fits the tool response. Imports
 * only `sharp`, `media-budget.ts` and `message-payload.ts` (explicit `.ts`), so a
 * plain `node` loads it for checks.
 *
 * Two hazards drive the shape. A small file can declare a huge canvas (a few
 * hundred bytes of PNG header claiming 30 000 x 30 000 px is ~2.7 GB once
 * decoded), so the header is read and the size refused *before* anything is
 * decoded; `limitInputPixels` is the second line, for what the header misstates.
 * And a phone photo carries GPS and device data in EXIF/XMP: every re-encode
 * here drops all metadata, and the unchanged original is handed back only when
 * it has none to drop.
 *
 * Shared libvips state is set once, here: no operation cache (a cache keeps
 * decoded pixels of attachments that belong to other people), two threads so
 * one request cannot take every core from the rest of the server.
 */
import sharp, { type Metadata } from 'sharp'
import { MAX_IMAGE_PIXELS, imageByteBudget, runImageLadder, type ImageAttempt } from './media-budget.ts'
import { detectImageMime } from './message-payload.ts'

sharp.cache(false)
sharp.concurrency(2)

export type PreparedImage =
  | {
    ok: true
    mimeType: string
    bytes: Buffer
    step: 0 | 1 | 2 | 3
    /** Size of `bytes` as displayed, i.e. after EXIF orientation. */
    width: number
    height: number
    /** Size of the source as displayed (a photo stored sideways reports its upright size). */
    originalWidth: number
    originalHeight: number
  }
  | { ok: false, reason: 'pixel-cap' | 'unreadable' | 'over-budget' }

/**
 * The canvas size the file's own header declares, read without a decoder. Not
 * a second opinion on what sharp reports: a header with nothing behind it (a
 * few dozen bytes of PNG announcing 30 000 x 30 000 px) is "corrupt" to libvips,
 * which then never says how big the picture claimed to be, so the refusal that
 * is about size would come back as "unreadable". `undefined` = no size found
 * here; sharp decides.
 */
function declaredSize(bytes: Buffer): { width: number, height: number } | undefined {
  const mime = detectImageMime(bytes)
  if (mime === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    return undefined
  }
  if (mime === 'image/jpeg') {
    // Walk the segments to the first frame header (SOF0-SOF15, bar the three that are not one).
    let pos = 2
    while (pos + 9 < bytes.length && bytes[pos] === 0xff) {
      const marker = bytes[pos + 1]!
      if (marker === 0xff) { pos++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(pos + 7), height: bytes.readUInt16BE(pos + 5) }
      }
      if (marker === 0xda) return undefined
      pos += 2 + bytes.readUInt16BE(pos + 2)
    }
  }
  return undefined
}

/**
 * PNG text chunks (tEXt, zTXt, iTXt), a late eXIf chunk, and anything after
 * IEND. sharp 0.35 does not report text chunks at all (`metadata.comments`
 * stays undefined for them), and they are free text that tools use for
 * coordinates, device and author; bytes after IEND are ignored by every decoder
 * and therefore by `metadata()`, yet step 0 hands the original back verbatim, so
 * a payload parked there would travel with it. Read here, bounded by the file:
 * one step per chunk header.
 */
function pngCarriesFreeText(bytes: Buffer): boolean {
  if (detectImageMime(bytes) !== 'image/png') return false
  let pos = 8
  while (pos + 8 <= bytes.length) {
    const type = bytes.toString('latin1', pos + 4, pos + 8)
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'eXIf') return true
    const next = pos + 12 + bytes.readUInt32BE(pos)
    if (type === 'IEND') return next < bytes.length
    pos = next
  }
  return false
}

/** EXIF orientations 5-8 store the picture on its side. */
function isSideways(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
}

export async function prepareImageForModel(bytes: Buffer): Promise<PreparedImage> {
  const open = () => sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })

  const declared = declaredSize(bytes)
  if (declared && declared.width * declared.height > MAX_IMAGE_PIXELS) return { ok: false, reason: 'pixel-cap' }

  let metadata: Metadata
  try {
    metadata = await open().metadata()
  } catch (error) {
    // A format `declaredSize` does not parse: sharp's own limit says the same thing.
    return { ok: false, reason: /pixel limit/i.test(String((error as Error)?.message)) ? 'pixel-cap' : 'unreadable' }
  }
  const { width: storedWidth, height: storedHeight } = metadata
  // 0 or missing would plan a zero-sized ladder; a header with no size is no image.
  if (!storedWidth || !storedHeight) return { ok: false, reason: 'unreadable' }
  if (storedWidth * storedHeight > MAX_IMAGE_PIXELS) return { ok: false, reason: 'pixel-cap' }

  const sideways = isSideways(metadata.orientation)
  const originalWidth = sideways ? storedHeight : storedWidth
  const originalHeight = sideways ? storedWidth : storedHeight

  // Anything that can carry where or with what a picture was taken disqualifies
  // the untouched original; `exif` is the contract, XMP and IPTC are the same
  // kind of data in other containers, and PNG text chunks are free text that tools
  // use for exactly this (coordinates, device, author).
  const carriesMetadata = Boolean(metadata.exif || metadata.xmp || metadata.iptc || metadata.tifftagPhotoshop || metadata.comments?.length || pngCarriesFreeText(bytes))

  const originalMime = detectImageMime(bytes)
  let result
  let output: { width: number, height: number } | undefined
  try {
    result = await runImageLadder({
      width: originalWidth,
      height: originalHeight,
      original: { bytes: bytes.length, usable: !carriesMetadata && originalMime !== undefined },
      budgetBytes: imageByteBudget(),
      encode: async (attempt: ImageAttempt) => {
        const { data, info } = await open()
          .rotate()
          .resize({ width: attempt.maxSide, height: attempt.maxSide, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: attempt.quality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true })
        // The ladder stops at the first encoding that fits, so the last one is the one returned.
        output = { width: info.width, height: info.height }
        return data
      }
    })
    // The header alone does not prove the body decodes, and step 0 never
    // decodes: a cut-off file would otherwise reach the model as "the image".
    if (result?.attempt.step === 0) await open().stats()
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!result) return { ok: false, reason: 'over-budget' }

  if (result.attempt.step === 0) {
    // Step 0 is only offered for a file whose magic bytes name one of the four types.
    return { ok: true, mimeType: originalMime!, bytes, step: 0, width: originalWidth, height: originalHeight, originalWidth, originalHeight }
  }
  return {
    ok: true,
    mimeType: 'image/jpeg',
    bytes: result.bytes!,
    step: result.attempt.step,
    width: output!.width,
    height: output!.height,
    originalWidth,
    originalHeight
  }
}
