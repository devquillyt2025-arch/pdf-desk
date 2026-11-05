# PageDesk — a PDF editor for searchable *and* scanned documents

Runs entirely in the browser. Nothing is uploaded unless you turn on the optional [cloud library](#cloud-library-optional)
and press *Save to cloud*. Open a PDF, click text to change it, save —
and the saved file is **re-opened and checked** against what you typed.

```bash
npm install
npm run dev          # http://localhost:5273   (first run copies fonts + OCR files into public/)
npm test             # ~180 tests on real PDFs: text editing, PDF tools, overlays, find & replace, tables, moving, cloud
npm run build        # type-check + production build into dist/
```

No API key or account is needed. The only network use is `npm install` and, on first run, one download of the
English OCR model (other OCR languages are fetched once, when you first pick them). The cloud library needs a
database and a passcode of your own (see below); without them it simply isn’t there.

## Home page and PDF tools

The home page is the hub: drop a PDF to edit it, or pick one of the tools below. The **Home** button in the top
bar (or the logo) takes you back from anywhere. If a document is open in the editor it stays open — scroll position
and unsaved edits included — and the home page offers *Continue editing* or *Close file* (which asks first if there
are unsaved edits).

| Tool | What it does |
|---|---|
| **Organize pages** | Thumbnails of every page. Click to select (or type `1-3, 5, 8-`), drag to re-order, rotate, duplicate, delete, or *Extract* the selected pages as a new PDF. |
| **Merge PDFs** | Add any number of PDFs (password-protected ones ask for their password), put them in order, join. Shared fonts and images are copied once, so the result isn’t bloated. |
| **Images to PDF** | JPG/PNG (and WebP/GIF/BMP/TIFF) → one page each. Same size as the picture, A4 or Letter, optional border. Phone photos with an EXIF “rotate me” flag come out upright. |
| **PDF to images** | Any pages (`all`, `1-3, 5`) as PNG at 72–300 dpi; one page downloads as a PNG, several as a ZIP. |
| **Page numbers & watermark** | `Page {n} of {N}` and friends at any corner or edge; a diagonal/straight text watermark with adjustable see-through. Live preview of the page you’re looking at. `₹` and other non-Latin characters use the bundled fallback font. |
| **Password** | Lock with AES-256, or save a copy that no longer asks for a password (you must know the current one). A forgotten password can’t be recovered. |

Every tool result can be downloaded or sent straight to the editor (*Edit this file*). The tools run in a second
engine worker, so using one never disturbs the document open in the editor. They are plain functions in
`src/engine/tools.ts` and are tested in Node like the rest of the engine.

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
dark/light theme.

## Marking up and drawing

The row under the top bar holds every tool. Marks go **on top of** the page — nothing underneath is removed or
re-encoded (a scan you only mark up keeps its original picture exactly) — and they are all undoable, listed under *Changes*,
and checked by *Save & verify* like any text edit: the report proves each mark shows up in the saved file and that
no pixel outside the marks moved.

| Tool (key) | What it does |
|---|---|
| **Highlight** `H` · **Underline** `U` · **Strike-out** `K` | Drag across text like selecting it: only the characters you cover are marked, line by line, forwards or backwards. The highlighter *multiplies* with the page, so the text stays readable. On a picture or an unrecognised scan, Highlight falls back to a plain box. |
| **Rectangle** `R` · **Ellipse** `O` · **Line** `L` · **Arrow** `A` · **Pen** `P` | Drag to draw (Shift = square / circle / 45° lines). Colour, line width and fill (none / tinted / solid) in the bar. |
| **Signature** `G` | Draw it once with mouse, finger or pen; it is kept on this device and placed with a click as a resizable drawing (black or blue ink). |
| **Picture** `I` | Logo, stamp, photo or a scan of your signature: choose a file, click where it goes. Large pictures are shrunk to 2400 px; WebP/AVIF are converted; phone photos come out upright. |
| **Select** `V` | Pick anything — marks, shapes, pictures, text, an edited table — with a click, `Shift`-click, a dragged box or `Ctrl+A`, and drag to move the whole pick (see *Moving things*). One shape picked alone can also be resized by a corner (pictures and drawings keep their shape; Shift frees them) and restyled. |
| **Find & replace** `Ctrl+F` | Searches every page (case / whole word), marks the matches on the page, steps through them with Enter / Shift+Enter, and replaces one or all. Replacements are ordinary text edits, so they are verified on save. |

Other keys: `E` edit text · `T` add text · `X` erase · `Ctrl+A` select all · `Esc` cancel · `Ctrl+Z/Y` · `Ctrl+S` save & verify.

## Moving things

**One thing — the move handle (Edit tool).** Point at a line of text, a mark, a shape or a picture and a blue **move
handle** appears on top of it, right where your pointer is (it holds still while you reach for it). Drag it to put the
thing somewhere else; hold `Shift` to keep it level or plumb. It never leaves the page.

**Several things, or everything — the Select tool (`V`).** Nothing to aim at: text, marks, shapes, pictures and edited
tables can be picked up and dragged by their body.

| To… | Do this |
|---|---|
| Pick one thing | Click it. |
| Add to / take from the pick | `Shift`- (or `Ctrl`-) click it. |
| Pick everything in an area | Drag a box on empty paper; it picks whatever the box touches. |
| Pick everything on the page | `Ctrl+A` (or *Select all* in the bar). |
| Move the pick | Drag any picked thing — the whole pick moves together, as **one undo step**. `Shift` keeps it level. |
| Nudge it | Arrow keys (`Shift` = 10×). The pick never leaves the page. |
| Remove what you added | `Delete` — marks, shapes, pictures and text you typed in. (The page's own text is changed with Erase.) |
| Start again | Click empty paper, or `Esc`. |

| What it is | What moving it does |
|---|---|
| A line of the page's own text — also in a scan once it has been recognised | The line is removed from where it was (for real) and set down again at the new place. |
| Text you edited or added | It moves; an edited line keeps its edit. |
| A highlight, shape, drawing, signature or picture | It moves. A single shape picked on its own also gets resize handles and its colour controls. |
| A table you edited | The whole table moves. Page text inside an edited table is part of that table and is not picked separately. |

In the Table tool the table's own move handle follows your pointer along its top edge too.

Saving checks a move like any other edit: the line must read the same where it landed, nothing may be left at the old
spot, and nothing else on the page may change. If it lands on top of other text, the report says so. Moving many lines
together is fine even though each one lands where its neighbour was — each is checked on its own. In a scan the hidden
searchable text moves with the picture of the line. Dragging a line back to where it was undoes the move.

## Editing tables

A PDF has no “table” object — only lines, filled boxes and loose text that line up. The **Table** tool (`B`) finds
that grid and lets you change it:

- **Click inside a table** to find it (it needs ruled lines). **Drag a box around a table that has no lines** and the
  columns and rows are read from where the text sits. Try it with *Report with a table* on the home page.
- The page shows the grid: click or drag to select cells, **Shift-click** to extend, click a number above / beside
  the table for a whole column or row, double-click (or `Enter`) to type in a cell (`Tab` = next cell).
- **Drag the edges** to resize columns and rows, or to make the whole table bigger. A table never grows off the page.
- The **Table** tab holds the rest: insert row above / below, column left / right, delete rows / columns, even columns,
  fit rows to text · **borders** (all / outside / inside / rows / columns / none, any colour, 0.25–3 pt) · **cell
  backgrounds** and **alternate-row stripes** · **text** colour, bold, italic, alignment, size · wrap long text ·
  delete the whole table (with *Bring it back*).

On save the old table (its lines, backgrounds and text, including any text that stuck out past its border) is
**removed from the file** and redrawn from what you see, then verified: every cell must read what you set, nothing of
the old table may be left, backgrounds and borders must really show, and the rest of the page must be pixel-identical.
If the table has grown onto other text, or off the page, the report says so.

Because a table is redrawn, its text is set in a matching built-in font (a DejaVu document stays DejaVu; others become
Helvetica / Times / Courier). Everything outside the table keeps its original glyphs.

## Cloud library (optional)

Everything above works with no server at all. If you add a [Neon](https://neon.tech) Postgres database, PageDesk can
also keep **your own** library in the cloud, behind one passcode:

- **Files** — *Save to cloud* (top bar) stores the open PDF. *Keep in library* in the save report stores the saved,
  verified copy next to its original. Files are stored once per unique content (same bytes → same entry) and each one
  is checked against its SHA-256 twice: by the database when the upload completes (bytes that do not match are never stored) and by the browser when it comes back.
- **Drafts** — once a file is in the library, your unsaved edits (text, marks, tables, pictures, proofreading and the
  text recognised on scans) are saved a couple of seconds after you stop. Open the file from the start page → *Continue
  draft* — on any device — and the edits are back (undo history is not kept). *Start over* discards the draft.
- **Save history** — every *Save & verify* adds a row: what changed, how many pages, whether the check passed.
  The PDF itself is only stored if you press *Keep in library*.
- **Settings** — signature, drawing style, theme, OCR language, review threshold and find options follow you
  between devices (the cloud wins when you sign in on a new device).

If the database isn’t configured — or the site is served from a plain static host — none of this shows up and the editor
behaves exactly as before.

### Set it up

1. Create a Neon project and copy its **pooled** connection string.
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `APP_PASSCODE` (8+ characters; it is the only thing that
   opens the library, so make it a real one). Never put these in a `VITE_…` variable — those are shipped to the browser.
3. `npm run dev` serves the API at `/api` from the same code Vercel runs. The tables are created on first use in the
   `pagedesk` schema (change with `DB_SCHEMA`); nothing is written to `public`.
4. On Vercel: add `DATABASE_URL` and `APP_PASSCODE` under *Settings → Environment Variables* and redeploy.

Optional: `DB_SCHEMA` (default `pagedesk`), `MAX_LIBRARY_MB` (default 400 — new uploads are refused beyond it).

### How it is built

```
server/cloud.ts          the whole API: one typed file, no relative imports (this is the source)
api/index.js             GENERATED from it by `npm run build:api` (runs before dev/build; a test fails if it is stale)
vercel.json              rewrites /api/* to that one function
src/cloud/               api.ts (fetch client) · useCloud · draft.ts · useSettingsSync · LibraryModal
```

- **Why generated JavaScript?** Vercel’s Node builder compiles TypeScript with the project’s own `typescript`
  package, and TypeScript 7 no longer has the API it needs. The source is erasable TypeScript, so Node’s built-in type
  stripping produces the function with the types removed. `package.json` pins `engines.node` to 24.x, which overrides the
  Vercel project’s Node setting.
- **Why a passcode token?** The site is public, so only a sign-in may reach the database. The token is an HMAC-signed
  value valid 30 days; changing the passcode signs every device out. Sign-in tries are throttled (8 per 15 minutes
  per address, counted before each try is judged, so parallel guesses cannot slip past). Nothing is readable without a token — the server answers 401 before it touches the database.
- **Why pieces?** A Vercel function takes at most ~4.5 MB per request, so files travel in 3 MB pieces (resumable;
  the whole file is hash-checked by the database when it completes). Hard limits: 60 MB per file, 4 MB (UTF-8 bytes) per draft (word boxes of recognised text are dropped
  first if a draft is that large), the library cap above.
- Tests (`tests/cloud.test.ts`) run against the real database in a throw-away schema that is dropped afterwards.

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
  overlay.ts  geometry of marks/shapes/pictures — one source for the on-screen SVG, the saved PDF content and the tests
  find.ts     find & replace within a line of text (pure)
  table.ts    table detection from lines + text, and the edit operations on a table model (pure)
  tools.ts    merge · rebuild (organise/extract/rotate) · images→PDF · passwords · stamps — stateless, no UI
  ranges.ts   "1-3, 5, 8-" page-range parser (pure, shared with the UI)   zip.ts   tiny ZIP writer (pure)
src/ocr/      Tesseract.js (offline English model bundled; other languages fetched once) → editable runs
src/ui/       React UI: viewer, inline editor, proofreading panel, report
src/cloud/    optional cloud library: API client, sign-in state, drafts, settings sync, library window
server/       the cloud API (typed source); api/index.js is generated from it for Vercel
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
- **Marks are page content, not PDF comments.** Once saved, a highlight or shape can’t be moved or removed
  individually in another app (it can here only until you save). A drawn signature is a *picture of* a signature —
  not a cryptographic digital signature, and not legally equivalent to one in places that require it.
- **Moving** works on text (and on scans once recognised), on things you added, and on tables. Pictures and drawings
  that are *part of the original PDF* are not separate objects the editor can lift, so they have no move handle — and
  *Select all* + drag moves the page's text lines (and what you added) but leaves such lines, backgrounds and pictures where
  they were. Every moved line is its own edit in the *Changes* list. A moved line is set down again in a matching built-in
  font, like any edited text.
- **Tables** work on pages with real text and lines, not scans. Merged cells are not understood (each is treated as
  separate cells), tables with only some lines drawn may need the drag-a-box route, and a table that already has text
  edits in it must have those undone first. A table that came with text running past its borders is redrawn as it was
  (one line per cell) until you switch on *Wrap long text inside cells*. There is no reflow: if a taller table reaches
  the text below it, the report warns instead of moving that text.
- **Find** matches within one line of same-styled text; a phrase that changes style mid-way (bold → regular) is
  found as separate words. Scans must be recognised (Proofread tab) before they can be searched.
- **PDF tools** rebuild a file from its pages: bookmarks, form fields and other document-level features may not be
  carried into a re-organised or merged file (the pages themselves — text, images, fonts — are). Passwords can’t
  contain a comma. Stamps use the bundled fonts only (Latin, Greek, Cyrillic, `₹`); add a font for other scripts with the **A** button.
- **Cloud library** is for one person (one passcode, no accounts). Two devices editing the same file’s draft at once:
  the last one to save wins. Pictures used in drafts are kept as hidden library files and are not removed when you
  delete the document they were used in. The passcode is sent over HTTPS to your own site; it is not a substitute for
  a full account system if you need to share the library.
- Recognition also “reads” QR codes and logos as junk lines; clear them in *Proofread* (empty the text).
- Scan font size/family are estimated from the picture; adjust them in the style bar.

## Licence note

PDF handling uses [MuPDF](https://mupdf.com) (AGPL-3.0). Fine for personal/local use; if you distribute or host
this app, AGPL terms (or a commercial MuPDF licence) apply.
