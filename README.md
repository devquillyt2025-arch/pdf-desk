# PageDesk — a PDF editor for searchable *and* scanned documents

Runs entirely in the browser. Nothing is uploaded. Open a PDF, click text to change it, save —
and the saved file is **re-opened and checked** against what you typed.

```bash
npm install
npm run dev          # http://localhost:5273   (first run copies fonts + OCR files into public/)
npm test             # 15 engine tests on real PDFs (searchable, scanned, rotated pages)
npm run build        # type-check + production build into dist/
```

## What it does

| | Searchable PDF | Scanned PDF |
|---|---|---|
| Edit text | Click a line → type. Old text is **removed from the file**, not covered with a white box. | Recognise (OCR) → click → type. The picture is patched at its original resolution, matching paper colour and grain. |
| Add text / erase / redact | ✔ | ✔ |
| Stays searchable | ✔ | ✔ — an invisible text layer is attached on export |
| Words you didn’t touch | Keep their original glyphs and position (“Keep untouched words”) | Keep their original pixels |
| Unicode | `₹`, Latin, Greek, Cyrillic built in; add a font for Tamil/Malayalam/Hindi/etc. | same |

**Pages that look like text but have none.** Many PDFs made by “Print to PDF” from a browser or a ticketing site
(IRCTC e-tickets, bank statements, web receipts) store the letters as vector *outlines*, not text. They can’t be
selected or searched, and the page contains no picture either. PageDesk detects these (“This page has no real text”)
and treats them like scans: recognise → proofread → edit. Only pages you actually edit are re-rendered (300 DPI);
other pages stay vector.

Extras: undo/redo, “Original” compare toggle, thumbnails, Ctrl+wheel zoom, password-protected PDFs,
dark/light theme, keyboard shortcuts (`E` edit · `T` add text · `X` erase · `Ctrl+Z/Y` · `Ctrl+S` save & verify).

## How “accurate” is it — and why you can trust it

No tool can promise 100 % OCR accuracy: on the bundled sample, Tesseract reads `₹` as `=`, `%` or `‘|`
and `…F1Z5` as `…F125`. So accuracy here comes from **checking**, not from trust:

1. **Flag** — low-confidence words and odd symbols are outlined in amber.
2. **Proofread** — the *Proofread* tab shows every recognised line as a crop of the original scan
   directly above its text. You confirm or fix each one (`Enter` = “matches scan”, moves to the next).
   Corrections change only the searchable layer, never the picture.
3. **Verify** — *Save & verify* re-opens the exported PDF and proves, per edit, that the file reads exactly
   what you typed; that every character outside your edits is unchanged and in the same place; and (scans)
   that the text layer matches what you reviewed and the pixels outside edited areas are unchanged.
   The report also states how many recognised lines you have *not* checked.

## Architecture

```
src/engine/   MuPDF (WASM) wrapper — pure TypeScript, runs in a Web Worker *and* in Node (that is how it is tested)
  engine.ts   analyse pages · extract runs · render · apply edits · export · verify
  plan.ts     decides what each edit clears/redraws (keep unchanged leading words)
  fonts.ts    base-14 + DejaVu fallback, per-glyph font selection, WinAnsi / glyph-id encoding
src/ocr/      Tesseract.js (offline English model bundled; other languages fetched once) → editable runs
src/ui/       React UI: viewer, inline editor, proofreading panel, report
tests/        node:test suite + generated fixtures (scripts/make-fixtures.mjs)
```

Edit model: a *run* = same-styled text on one line (a table cell, a label, a line of a paragraph).
Vector pages: MuPDF redaction removes the glyphs, then replacement text is appended to the page content in
the closest matching font. Scanned pages: the page is rendered at the scan’s DPI, old ink is replaced by
sampled paper (with matched noise), new text is rasterised, and the page image is re-encoded; unedited pages
are never touched.

## Known limits (be aware)

- **Reading order**: redrawn text is appended to the page’s content stream, so *copy/paste order* of an edited
  line can differ from visual order (`₹` stays in place, the new digits come last). Search for the whole
  line may miss; search for the new words works. Turn off “Keep untouched words” to re-typeset a whole line as one piece.
- **Fonts**: embedded subset fonts can’t be reused for new characters, so edited text uses Helvetica / Times /
  Courier (metric-compatible with Arial / Times New Roman / Courier New) or DejaVu. Exotic brand fonts will differ slightly on the changed words.
- **No reflow**: lengthening a line doesn’t re-wrap the paragraph; the verifier warns if new text runs into neighbours.
- Only horizontal text is clickable (erase works anywhere). Form fields, annotations and digital signatures
  are not edited (editing a signed PDF invalidates its signature). Saved copies are not password protected.
- Recognition also “reads” QR codes and logos as junk lines; clear them in *Proofread* (empty the text).
- Scan font size/family are estimated from the picture; adjust them in the style bar.

## Licence note

PDF handling uses [MuPDF](https://mupdf.com) (AGPL-3.0). Fine for personal/local use; if you distribute or host
this app, AGPL terms (or a commercial MuPDF licence) apply.
