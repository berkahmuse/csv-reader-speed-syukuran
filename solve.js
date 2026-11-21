// csv-reader-speed — a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns csv-reader 1.0.0's exact answer for every {text, header}
// input — {columns, rows, errors} with the same broken-row policy (BOM drop,
// blank lines are no records, stray CRs dropped outside quotes, CR/CRLF inside
// quotes read as LF, doubled quotes, quote junk after a closing quote,
// unterminated quotes re-read as unquoted, short rows padded, long rows cut,
// every error recorded in the order met) — reached by a different route:
//
//   - Record fast path: a record that is one physical line holding no double
//     quote and no carriage return but its line break's own is split in one
//     String.split(',') after two indexOf probes.
//   - Field slow path: indexOf jumps between the characters that can end a
//     field (comma, LF, CR) instead of a character-at-a-time walk; a quoted
//     field is copied in whole chunks between its quotes, and a chunk is only
//     reworked (CRs turned to LFs, line breaks counted) when it truly holds
//     a CR or an LF.
//   - Readers report through shared out-variables (fVal, fEnded, fAdded), so
//     no result object is allocated per field, and field text is sliced once
//     from the input, never built up character by character.
//
// Pure: no clock, no randomness, no state kept between calls.

const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters of
  // text were kept for it (the quote_junk test reads fAdded).
  let fVal = '';
  let fEnded = ENDED_END;
  let fAdded = 0;

  // Next CR / LF at or after the last probe, cached across reads: both are
  // rare next to commas, and an uncached indexOf for one re-scans the whole
  // tail of the text on every field. A cache entry is trusted only for probe
  // points at or after the point it was probed from — the unterminated-quote
  // re-read steps pos back to the opening quote, and a probe point behind
  // the cached one probes again.
  let nCr = -1;
  let nCrFrom = Infinity;
  let nLf = -1;
  let nLfFrom = Infinity;
  function nextCr(from) {
    if (from < nCrFrom || (nCr !== -1 && nCr < from)) {
      nCr = text.indexOf('\r', from);
      nCrFrom = from;
    }
    return nCr;
  }
  function nextLf(from) {
    if (from < nLfFrom || (nLf !== -1 && nLf < from)) {
      nLf = text.indexOf('\n', from);
      nLfFrom = from;
    }
    return nLf;
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line
  // break. A CR not followed by LF is dropped and recorded as stray_cr.
  function readUnquoted(prefix) {
    let parts = null;
    let seg = pos;
    let added = 0;
    for (;;) {
      const iComma = text.indexOf(',', pos);
      const iLf = nextLf(pos);
      const iCr = nextCr(pos);
      let idx = -1;
      if (iComma !== -1) idx = iComma;
      if (iLf !== -1 && (idx === -1 || iLf < idx)) idx = iLf;
      if (iCr !== -1 && (idx === -1 || iCr < idx)) idx = iCr;
      if (idx === -1) {
        fAdded = added + (len - seg);
        fVal = parts === null
          ? prefix + text.slice(seg)
          : prefix + (parts.push(text.slice(seg)), parts.join(''));
        pos = len;
        fEnded = ENDED_END;
        return;
      }
      const c = text[idx];
      if (c === '\r' && text[idx + 1] !== '\n') {
        // Stray CR: dropped, the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(seg, idx));
        added += idx - seg;
        pos = idx + 1;
        seg = pos;
        continue;
      }
      fAdded = added + (idx - seg);
      fVal = parts === null
        ? prefix + text.slice(seg, idx)
        : prefix + (parts.push(text.slice(seg, idx)), parts.join(''));
      if (c === ',') {
        pos = idx + 1;
        fEnded = ENDED_COMMA;
      } else if (c === '\n') {
        pos = idx + 1;
        line += 1;
        fEnded = ENDED_BREAK;
      } else {
        // CR of a CRLF pair.
        pos = idx + 2;
        line += 1;
        fEnded = ENDED_BREAK;
      }
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let parts = null;
    let seg = pos;
    for (;;) {
      const iq = text.indexOf('"', pos);
      if (iq === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      // The chunk before this quote: reworked only when it holds a CR or LF.
      let chunk = null;
      if (iq > seg) {
        const iCr = nextCr(seg);
        const iLf = nextLf(seg);
        if ((iCr !== -1 && iCr < iq) || (iLf !== -1 && iLf < iq)) {
          chunk = text.slice(seg, iq);
          const breaks = chunk.match(/\r\n|\r|\n/g);
          if (breaks !== null) line += breaks.length;
          chunk = chunk.replace(/\r\n|\r/g, '\n');
        } else {
          chunk = text.slice(seg, iq);
        }
      }
      if (text[iq + 1] === '"') {
        // A doubled quote: one literal quote, the field goes on.
        if (parts === null) parts = [];
        if (chunk !== null) parts.push(chunk);
        parts.push('"');
        pos = iq + 2;
        seg = pos;
        continue;
      }
      // The closing quote.
      fVal = parts === null
        ? (chunk === null ? '' : chunk)
        : (chunk !== null && parts.push(chunk), parts.join(''));
      pos = iq + 1;
      break;
    }
    if (pos >= len) {
      fEnded = ENDED_END;
      return;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      fEnded = ENDED_COMMA;
      return;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      fEnded = ENDED_BREAK;
      return;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      fEnded = ENDED_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break; quote_junk when anything was appended.
    const value = fVal;
    readUnquoted(value);
    if (fAdded > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;

    // Fast path probe: this record is one physical line when no double quote
    // sits before its line break and no CR sits there but the break's own.
    const nl = nextLf(pos);
    const segEnd = nl === -1 ? len : nl;
    const iq = text.indexOf('"', pos);
    if (iq === -1 || iq >= segEnd) {
      const iCr = nextCr(pos);
      if (iCr === -1 || iCr >= segEnd || (iCr === segEnd - 1 && nl !== -1)) {
        const contentEnd = nl !== -1 && text[segEnd - 1] === '\r' ? segEnd - 1 : segEnd;
        if (contentEnd > pos) {
          fields = text.slice(pos, contentEnd).split(',');
          pos = nl === -1 ? len : nl + 1;
          if (nl !== -1) line += 1;
        }
      }
    }

    if (fields === null) {
      fields = [];
      let quoted = false;
      do {
        quoted = text[pos] === '"';
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fVal);
      } while (fEnded === ENDED_COMMA);
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
