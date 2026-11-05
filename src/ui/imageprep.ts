// Getting a picture file into bytes MuPDF can embed: upright, in a format it reads, and not absurdly large.

/** Formats MuPDF reads directly; anything else the browser can decode is converted to PNG first. */
const NATIVE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'])

/** EXIF orientation (1–8) of a JPEG, or 1. Phone photos are often stored sideways with a flag saying "turn me". */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let p = 2
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return 1
    const marker = b[p + 1]
    const len = dv.getUint16(p + 2)
    if (marker === 0xe1 && dv.getUint32(p + 4) === 0x45786966) {
      const t = p + 10 // start of the TIFF header
      const le = dv.getUint16(t) === 0x4949
      const ifd = t + dv.getUint32(t + 4, le)
      const n = dv.getUint16(ifd, le)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le)
      }
      return 1
    }
    if (marker === 0xda) return 1
    p += 2 + len
  }
  return 1
}

export interface PreparedImage {
  name: string
  bytes: Uint8Array
  /** MIME type of `bytes` */
  type: string
}

/**
 * Bytes that can be embedded as they are. A picture is re-encoded through a canvas only when it has to be: a JPEG
 * with an EXIF turn, a format MuPDF doesn't read (WebP, AVIF…), or one longer than `maxSide` pixels.
 */
export async function prepareImage(file: File, opts: { maxSide?: number } = {}): Promise<PreparedImage> {
  const raw = new Uint8Array(await file.arrayBuffer())
  const type = file.type || (/\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.png$/i.test(file.name) ? 'image/png' : '')
  // (a damaged JPEG can point past its own end: that is "no turn", and the decoder below gives the real verdict)
  const turned =
    type === 'image/jpeg' &&
    (() => {
      try {
        return jpegOrientation(raw) > 1
      } catch {
        return false
      }
    })()
  const native = NATIVE.has(type)
  if (native && !turned && !opts.maxSide) return { name: file.name, bytes: raw, type }
  try {
    // createImageBitmap applies the EXIF orientation for us.
    const bmp = await createImageBitmap(new Blob([raw as BlobPart], { type }), { imageOrientation: 'from-image' })
    const big = opts.maxSide ? Math.max(bmp.width, bmp.height) > opts.maxSide : false
    if (native && !turned && !big) {
      bmp.close()
      return { name: file.name, bytes: raw, type }
    }
    const k = big ? opts.maxSide! / Math.max(bmp.width, bmp.height) : 1
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(bmp.width * k))
    cv.height = Math.max(1, Math.round(bmp.height * k))
    cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height)
    bmp.close()
    const asJpeg = type === 'image/jpeg'
    const outType = asJpeg ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, outType, 0.93))
    if (!blob) throw new Error('empty')
    return { name: file.name, bytes: new Uint8Array(await blob.arrayBuffer()), type: outType }
  } catch {
    throw new Error(`“${file.name}” couldn’t be read as a picture. Try a JPG or PNG.`)
  }
}
