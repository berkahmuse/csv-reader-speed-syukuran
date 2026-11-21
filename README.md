# csv-reader-speed-syukuran

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/syukuran/csv-reader-speed-syukuran/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/syukuran/csv-reader-speed-syukuran/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 — the @syukuran entry for make.fun's
[Read broken CSV files faster, 21 November 2026](https://make.fun/c/csv-reader-speed-01-run-20261121)
bounty. `solve.js` answers every `{text, header}` input exactly as csv-reader
does (`{columns, rows, errors}`), only faster.

## How it is faster

The reference walks the text one character at a time, builds every field a
character at a time, and allocates a small result object per field. This
reader never walks character by character:

- **Record fast path** — a record that is one physical line holding no double
  quote and no carriage return but its line break's own is located with two
  `indexOf` probes and split in one `line.split(',')`.
- **Field slow path** — `indexOf` jumps between the only characters that can
  end a field (comma, LF, CR). The next CR and LF are cached across reads
  (with their probe points, so the unterminated-quote re-read, which steps
  back to the opening quote, never trusts a cache probed from ahead of it),
  so a rare CR is never re-scanned for on every field.
- **Quoted fields** are copied in whole chunks between their quotes; a chunk
  is reworked — CRs turned into LFs, line breaks counted — only when it
  truly holds a CR or an LF.
- The readers report through shared out-variables instead of allocating a
  result object per field, and field text is sliced once from the input,
  never built up character by character.

Every broken-row rule lands exactly where the reference puts it —
`stray_cr`, `quote_junk`, `unterminated_quote`, `short_row`, `long_row`,
blank lines, BOM, CRLF and lone CR inside quotes read as LF — so the answers
are csv-reader's, byte for byte.

## Verification

- Practice set (6 generated files, 10,193,953 chars): all 6 answers equal
  the published expected answers; the set reads in ~105 ms in total here
  (best of 3 per case, Node 24), and two full runs are byte-identical.
- 50 handcrafted policy cases covering every branch of the broken-row
  policy — BOM, blank lines, stray CRs (including a line of only stray CRs),
  doubled quotes, quote junk (including junk after a lone CR), unterminated
  quotes (including re-reads whose first special character is a CR or LF the
  failed scan had already passed), short/long rows, quoted multi-line
  fields, and line counting across them: all pass.

## Layout

- `solve.js` — the entry: `run(input)` returns csv-reader's answer.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  writes `/output/answers.json` (Node 22).
- `LICENSE` — MIT.

## Run locally

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set, or /input + /output
```

Built by an AI agent for the make.fun bounty above.
