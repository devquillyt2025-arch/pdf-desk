// Minimal "stored" (uncompressed) ZIP writer. PNG/JPEG/PDF are already compressed, so storing is fine,
// and it keeps us free of a dependency. Pure TypeScript — runs in the browser and in Node.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

export function zip(files: ZipEntry[]): Uint8Array {
  if (files.length > 0xfffe) throw new Error('Too many files for one ZIP.')
  const enc = new TextEncoder()
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  const names = files.map((f) => enc.encode(f.name))
  const crcs = files.map((f) => crc32(f.data))
  const total = files.reduce((s, f, i) => s + 30 + names[i].length + f.data.length + 46 + names[i].length, 22)
  if (total > 0xfffffff0) throw new Error('These files are too big for one ZIP (4 GB limit). Use fewer pages.')

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let p = 0
  const offsets: number[] = []

  files.forEach((f, i) => {
    offsets.push(p)
    dv.setUint32(p, 0x04034b50, true)
    dv.setUint16(p + 4, 20, true) // version needed
    dv.setUint16(p + 6, 0x0800, true) // UTF-8 names
    dv.setUint16(p + 8, 0, true) // stored
    dv.setUint16(p + 10, dosTime, true)
    dv.setUint16(p + 12, dosDate, true)
    dv.setUint32(p + 14, crcs[i], true)
    dv.setUint32(p + 18, f.data.length, true)
    dv.setUint32(p + 22, f.data.length, true)
    dv.setUint16(p + 26, names[i].length, true)
    dv.setUint16(p + 28, 0, true)
    out.set(names[i], p + 30)
    out.set(f.data, p + 30 + names[i].length)
    p += 30 + names[i].length + f.data.length
  })

  const cdStart = p
  files.forEach((f, i) => {
    dv.setUint32(p, 0x02014b50, true)
    dv.setUint16(p + 4, 20, true) // made by
    dv.setUint16(p + 6, 20, true) // needed
    dv.setUint16(p + 8, 0x0800, true)
    dv.setUint16(p + 10, 0, true)
    dv.setUint16(p + 12, dosTime, true)
    dv.setUint16(p + 14, dosDate, true)
    dv.setUint32(p + 16, crcs[i], true)
    dv.setUint32(p + 20, f.data.length, true)
    dv.setUint32(p + 24, f.data.length, true)
    dv.setUint16(p + 28, names[i].length, true)
    dv.setUint16(p + 30, 0, true) // extra
    dv.setUint16(p + 32, 0, true) // comment
    dv.setUint16(p + 34, 0, true) // disk
    dv.setUint16(p + 36, 0, true) // internal attrs
    dv.setUint32(p + 38, 0, true) // external attrs
    dv.setUint32(p + 42, offsets[i], true)
    out.set(names[i], p + 46)
    p += 46 + names[i].length
  })

  dv.setUint32(p, 0x06054b50, true)
  dv.setUint16(p + 8, files.length, true)
  dv.setUint16(p + 10, files.length, true)
  dv.setUint32(p + 12, p - cdStart, true)
  dv.setUint32(p + 16, cdStart, true)
  return out
}
