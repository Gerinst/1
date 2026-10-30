// =====================================================================
//  Avis PDF Amount – Office Script (Power Automate "Run script")
//  Extracts the embedded text of a text-based PDF and finds the payment /
//  total amount. Pure TypeScript, no libraries, no network.
//  Pipeline: Base64 -> bytes -> PDF objects (incl. object streams) ->
//  page tree -> content streams (FlateDecode, LZW, A85, AHx, RL) ->
//  font decoding (WinAnsi/MacRoman/Standard/Differences, ToUnicode,
//  Identity-H, embedded TrueType cmap) -> lines -> amount heuristic.
//  The input may also be a mail container (S/MIME "smime.p7m", .eml):
//  the PDF inside is used; the signature is not verified.
// =====================================================================

// ---------------------------------------------------------------------
// Result contract (what Power Automate receives)
// ---------------------------------------------------------------------
interface AvisResult {
  ok: boolean;            // amount found
  amount: string;         // as printed, e.g. "3.454,00"
  amountNumber: number;   // 3454
  currency: string;       // "EUR" (default) / "USD" / "CHF" / "GBP"
  line: string;           // the text line the amount was taken from
  method: string;         // how it was chosen: keyword / keyword-next-line / column-sum / largest / none
  confidence: string;     // high / medium / low – route "low" to a manual check
  candidates: string[];   // top candidates "amount | score | line" for debugging
  pages: number;
  text: string;           // extracted text (capped)
  textLength: number;
  warnings: string;
  error: string;
}

// ---------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(input: string): Uint8Array {
  let s = input;
  // tolerate a JSON file object {"$content-type":"...","$content":"..."} (also JSON-escaped) or a data URI
  const m = /"\$content"\s*:\s*"([^"]*)"/.exec(s) || /\\"\$content\\"\s*:\s*\\"((?:[^"\\]|\\\/)*)\\"/.exec(s);
  if (m) s = m[1];
  const comma = s.indexOf(",");
  if (s.substring(0, 5) === "data:" && comma > 0) s = s.substring(comma + 1);
  return decodeBase64Range(s, 0, s.length);
}

// Windows-1252 code points of the bytes 0x80-0x9F (0 = byte not defined in Windows-1252)
const CP1252_HIGH = [0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178];
// start of a mail header block (raw .eml / clear-signed smime.p7m passed as text)
const MAIL_HEAD_TEXT = /^\s*(?:mime-version|content-type|received|return-path|from|date|message-id|subject)\s*:/i;

// How the file arrived: form "base64" (normal), "base64x2" (Base64 of the Base64 text, e.g. base64(contentBytes)),
// "text" (the flow passed the file as text); damaged = characters that could not be turned back into bytes (U+FFFD)
interface InputBytes { bytes: Uint8Array; form: string; damaged: number }

function decodeInput(input: string): InputBytes {
  // Base64 is printable ASCII without '%' or ':', so "%PDF-", a mail header or a control / non-ASCII character
  // near the start means the file came as text (a leading byte-order mark is ignored)
  const src = input.charCodeAt(0) === 0xfeff ? input.substring(1) : input;
  const head = src.substring(0, 2048);
  if (head.indexOf("%PDF-") >= 0 || MAIL_HEAD_TEXT.test(head) || /[^\t\n\r\x20-\x7e]/.test(head.substring(0, 256))) return textToBytes(src);
  const bytes = base64ToBytes(src);
  if (bytes.length >= 16 && isBase64Text(bytes)) {
    const inner = decodeBase64Range(bytesToLatin1(bytes, 0, bytes.length), 0, bytes.length);
    const innerHead = bytesToLatin1(inner, 0, Math.min(inner.length, 2048));
    if (inner.length >= 8 && (innerHead.indexOf("%PDF") >= 0 || MAIL_HEAD_TEXT.test(innerHead) || inner[0] === 0x30)) {
      return { bytes: inner, form: "base64x2", damaged: 0 };
    }
  }
  return { bytes: bytes, form: "base64", damaged: 0 };
}

function isBase64Text(b: Uint8Array): boolean {
  // the first bytes are Base64 digits only (a PDF starts with "%PDF", a mail with "Name:", CMS with 0x30)
  const n = Math.min(b.length, 256);
  let digits = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    const digit = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || c === 0x2d || c === 0x5f;
    if (digit) digits++;
    else if (c !== 0x3d && c !== 0x0d && c !== 0x0a && c !== 0x20 && c !== 0x09) return false;
  }
  return digits >= 16;
}

function textToBytes(s: string): InputBytes {
  // undo the text decoding of a file: Latin-1 / Windows-1252 text maps back byte for byte;
  // UTF-8 text is encoded again, but bytes that were not valid UTF-8 became U+FFFD and are lost
  let utf8 = false, damaged = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) damaged++;
    else if (c > 0xff && CP1252_HIGH.indexOf(c) < 0) utf8 = true;
  }
  if (damaged > 0) utf8 = true;
  const out = new Uint8Array(utf8 ? s.length * 3 : s.length);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!utf8) {
      const k = c > 0xff ? CP1252_HIGH.indexOf(c) : -1;
      out[o++] = c <= 0xff ? c : k >= 0 ? 0x80 + k : 0x3f;
    } else if (c < 0x80) out[o++] = c;
    else if (c === 0xfffd) out[o++] = 0x3f; // a lost byte
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
      i++;
      out[o++] = 0xf0 | (cp >> 18);
      out[o++] = 0x80 | ((cp >> 12) & 0x3f);
      out[o++] = 0x80 | ((cp >> 6) & 0x3f);
      out[o++] = 0x80 | (cp & 0x3f);
    } else {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 0x3f);
      out[o++] = 0x80 | (c & 0x3f);
    }
  }
  return { bytes: out.subarray(0, o), form: "text", damaged: damaged };
}

function describeInput(s: string): string {
  // length and first characters of the script input, for the error text (no file content beyond the header)
  return s.length + " chars, starts '" + s.substring(0, 12).replace(/[^\x20-\x7e]/g, "?").replace(/'/g, "?") + "'";
}

function decodeBase64Range(s: string, start: number, end: number): Uint8Array {
  // Base64 digits of s[start, end); other characters (line breaks, '=') are skipped, '-' / '_' are url-safe digits
  const lookup = new Int16Array(256);
  for (let i = 0; i < 256; i++) lookup[i] = -1;
  for (let i = 0; i < 64; i++) lookup[B64_ALPHABET.charCodeAt(i)] = i;
  lookup[45] = 62; // '-' (url-safe)
  lookup[95] = 63; // '_'
  const out = new Uint8Array(Math.floor((Math.max(0, end - start) * 3) / 4) + 3);
  let acc = 0, bits = 0, o = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) continue;
    const v = lookup[c];
    if (v < 0) continue;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function bytesToLatin1(b: Uint8Array, start: number, end: number): string {
  // bytes -> "latin1" string (one char per byte)
  let s = "";
  const CH = 4096;
  for (let i = start; i < end; i += CH) {
    const stop = Math.min(i + CH, end);
    const arr: number[] = [];
    for (let j = i; j < stop; j++) arr.push(b[j]);
    s += String.fromCharCode(...arr);
  }
  return s;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------
// Inflate (zlib / raw deflate) – lenient: returns what could be decoded
// ---------------------------------------------------------------------
class BitReader {
  data: Uint8Array;
  pos: number;
  bitBuf: number;
  bitCnt: number;
  eof: boolean;
  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.eof = false;
  }
  bits(n: number): number {
    let val = this.bitBuf;
    while (this.bitCnt < n) {
      if (this.pos >= this.data.length) {
        this.eof = true;
        return -1;
      }
      val |= this.data[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> n;
    this.bitCnt -= n;
    return val & ((1 << n) - 1);
  }
}

interface Huffman {
  count: Int16Array; // 0..15
  symbol: Int16Array;
}

function huffBuild(lengths: Uint8Array, n: number): Huffman {
  const count = new Int16Array(16);
  const symbol = new Int16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Int16Array(16);
  for (let l = 1; l < 16; l++) offs[l] = offs[l - 1] + count[l - 1];
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
  return { count: count, symbol: symbol };
}

function huffDecode(br: BitReader, h: Huffman): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    const b = br.bits(1);
    if (b < 0) return -1;
    code |= b;
    const count = h.count[len];
    if (code - count < first) return h.symbol[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  return -1;
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let FIXED_LIT: Huffman | null = null;
let FIXED_DIST: Huffman | null = null;

// hard limits against decompression bombs / runaway input
const MAX_STREAM_BYTES = 64 * 1024 * 1024;   // decoded size of a single stream
const MAX_TOTAL_DECODED = 256 * 1024 * 1024; // decoded size of all streams together
let totalDecoded = 0;
let runDeadline = 0; // Date.now() value after which decoding and interpretation stop (set in main)

class ByteSink {
  buf: Uint8Array;
  len: number;
  constructor(cap: number) {
    this.buf = new Uint8Array(Math.min(Math.max(cap, 1024), MAX_STREAM_BYTES));
    this.len = 0;
  }
  ensure(extra: number): void {
    if (this.len + extra > this.buf.length) {
      let n = this.buf.length * 2;
      while (n < this.len + extra) n *= 2;
      if (n > MAX_STREAM_BYTES) throw new Error("decoded stream exceeds " + MAX_STREAM_BYTES + " bytes");
      const nb = new Uint8Array(n);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
  }
  push(b: number): void {
    if (this.len >= this.buf.length) this.ensure(1);
    this.buf[this.len++] = b;
  }
  result(): Uint8Array {
    totalDecoded += this.len;
    if (totalDecoded > MAX_TOTAL_DECODED) throw new Error("decoded data exceeds " + MAX_TOTAL_DECODED + " bytes");
    return this.buf.subarray(0, this.len);
  }
}

/** result of a decoder: complete=false when the data ended early or was corrupt (text may be partial) */
interface Decoded { data: Uint8Array; complete: boolean }

function inflateRaw(data: Uint8Array, pos: number): Decoded {
  // inflate raw deflate data starting at `pos`; complete = the final block was decoded to its end
  const br = new BitReader(data, pos);
  const out = new ByteSink(data.length * 4);
  let last = 0;
  let broken = false;
  let finished = false; // final block decoded to its end-of-block code
  while (!last && !broken) {
    last = br.bits(1);
    const type = br.bits(2);
    if (last < 0 || type < 0) break;
    if (type === 0) {
      // stored
      br.bitBuf = 0;
      br.bitCnt = 0;
      if (br.pos + 4 > data.length) break;
      const len = data[br.pos] | (data[br.pos + 1] << 8);
      br.pos += 4;
      out.ensure(len);
      for (let i = 0; i < len; i++) {
        if (br.pos >= data.length) { broken = true; break; }
        out.buf[out.len++] = data[br.pos++];
      }
      if (!broken && last === 1) finished = true;
      continue;
    }
    let lit: Huffman, dist: Huffman;
    if (type === 1) {
      if (!FIXED_LIT) {
        const l = new Uint8Array(288);
        let i = 0;
        for (; i < 144; i++) l[i] = 8;
        for (; i < 256; i++) l[i] = 9;
        for (; i < 280; i++) l[i] = 7;
        for (; i < 288; i++) l[i] = 8;
        FIXED_LIT = huffBuild(l, 288);
        const d = new Uint8Array(30);
        for (i = 0; i < 30; i++) d[i] = 5;
        FIXED_DIST = huffBuild(d, 30);
      }
      lit = FIXED_LIT;
      dist = FIXED_DIST as Huffman;
    } else if (type === 2) {
      const nlen = br.bits(5) + 257;
      const ndist = br.bits(5) + 1;
      const ncode = br.bits(4) + 4;
      if (nlen > 286 || ndist > 30) break;
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = br.bits(3);
      if (br.eof) break;
      const lencode = huffBuild(lengths, 19);
      let idx = 0;
      const ll = new Uint8Array(320);
      while (idx < nlen + ndist) {
        let sym = huffDecode(br, lencode);
        if (sym < 0) { broken = true; break; }
        if (sym < 16) {
          ll[idx++] = sym;
        } else {
          let len = 0, rep = 0;
          if (sym === 16) {
            if (idx === 0) { broken = true; break; }
            len = ll[idx - 1];
            rep = 3 + br.bits(2);
          } else if (sym === 17) {
            rep = 3 + br.bits(3);
          } else {
            rep = 11 + br.bits(7);
          }
          if (idx + rep > nlen + ndist) { broken = true; break; }
          while (rep-- > 0) ll[idx++] = len;
        }
      }
      if (broken || br.eof) break;
      lit = huffBuild(ll.subarray(0, nlen), nlen);
      dist = huffBuild(ll.subarray(nlen, nlen + ndist), ndist);
    } else {
      break; // invalid block type
    }
    // decode compressed block
    for (;;) {
      let sym = huffDecode(br, lit);
      if (sym < 0) { broken = true; break; }
      if (sym < 256) {
        out.push(sym);
      } else if (sym === 256) {
        if (last === 1) finished = true;
        break;
      } else {
        sym -= 257;
        if (sym >= 29) { broken = true; break; }
        const eb = br.bits(LEN_EXTRA[sym]);
        if (eb < 0) { broken = true; break; }
        const len = LEN_BASE[sym] + eb;
        const ds = huffDecode(br, dist);
        if (ds < 0 || ds >= 30) { broken = true; break; }
        const de = br.bits(DIST_EXTRA[ds]);
        if (de < 0) { broken = true; break; }
        const d = DIST_BASE[ds] + de;
        if (d > out.len) { broken = true; break; }
        out.ensure(len);
        let src = out.len - d;
        for (let i = 0; i < len; i++) out.buf[out.len++] = out.buf[src++];
      }
    }
  }
  return { data: out.result(), complete: finished && !broken };
}

function inflate(data: Uint8Array): Decoded {
  let p = 0;
  // skip leading whitespace/garbage some producers emit before the zlib header
  while (p < data.length && (data[p] === 0x0a || data[p] === 0x0d || data[p] === 0x20 || data[p] === 0x09)) p++;
  if (p + 2 <= data.length) {
    const cmf = data[p], flg = data[p + 1];
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
      let start = p + 2;
      if (flg & 0x20) start += 4; // preset dictionary id
      const r = inflateRaw(data, start);
      if (r.data.length > 0 || r.complete) return r; // an empty but well-formed stream is complete
    }
  }
  const raw = inflateRaw(data, p);
  if (raw.data.length > 0 || raw.complete) return raw;
  const junk = inflateRaw(data, p + 1); // last resort: one byte of junk
  return { data: junk.data, complete: junk.complete || data.length === 0 };
}

function applyPredictor(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
  // Predictors (PNG / TIFF) for FlateDecode & LZWDecode
  if (predictor <= 1) return data;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc === 8) {
      const rows = Math.floor(data.length / rowLen);
      for (let r = 0; r < rows; r++) {
        const off = r * rowLen;
        for (let i = bpp; i < rowLen; i++) data[off + i] = (data[off + i] + data[off + i - bpp]) & 0xff;
      }
    }
    return data;
  }
  // PNG predictors: each row prefixed with a filter type byte
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const inOff = r * (rowLen + 1) + 1;
    const outOff = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[inOff + i];
      const left = i >= bpp ? out[outOff + i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = raw;
      if (ft === 1) v = raw + left;
      else if (ft === 2) v = raw + up;
      else if (ft === 3) v = raw + ((left + up) >> 1);
      else if (ft === 4) {
        const pp = left + up - ul;
        const pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - ul);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[outOff + i] = v & 0xff;
    }
    for (let i = 0; i < rowLen; i++) prev[i] = out[outOff + i];
  }
  return out;
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  // ASCIIHexDecode (the other filters follow: ASCII85, RunLength, LZW)
  const out = new ByteSink(data.length >> 1);
  let digit = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>'
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    else continue;
    if (digit < 0) digit = v;
    else {
      out.push((digit << 4) | v);
      digit = -1;
    }
  }
  if (digit >= 0) out.push(digit << 4);
  return out.result();
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out = new ByteSink(data.length);
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // '<~'
  const tuple: number[] = [];
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~'
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0) continue;
    if (c === 0x7a && tuple.length === 0) { // 'z'
      out.push(0); out.push(0); out.push(0); out.push(0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple.push(c - 33);
    if (tuple.length === 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 85 + tuple[k];
      out.push((v >>> 24) & 0xff); out.push((v >>> 16) & 0xff); out.push((v >>> 8) & 0xff); out.push(v & 0xff);
      tuple.length = 0;
    }
  }
  if (tuple.length > 1) {
    const n = tuple.length;
    for (let k = n; k < 5; k++) tuple.push(84);
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + tuple[k];
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
  }
  return out.result();
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out = new ByteSink(data.length * 2);
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) {
      for (let k = 0; k <= l && i < data.length; k++) out.push(data[i++]);
    } else {
      const b = data[i++];
      for (let k = 0; k < 257 - l; k++) out.push(b);
    }
  }
  return out.result();
}

function lzwDecode(data: Uint8Array, earlyChange: number): Decoded {
  // LZW; complete = the end-of-data code was reached
  const out = new ByteSink(data.length * 3);
  // no local reset helper: the table is built here once and cut back to 258 entries on a clear code
  const dict: number[][] = [];
  for (let i = 0; i < 256; i++) dict.push([i]);
  dict.push([]); // 256 = clear table
  dict.push([]); // 257 = end of data
  let codeLen = 9;
  let prev: number[] | null = null;
  let bitBuf = 0, bitCnt = 0, pos = 0;
  let complete = false;
  while (true) {
    while (bitCnt < codeLen) {
      if (pos >= data.length) return { data: out.result(), complete: false };
      bitBuf = ((bitBuf << 8) | data[pos++]) >>> 0;
      bitCnt += 8;
    }
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    bitBuf &= (1 << bitCnt) - 1;
    if (code === 256) { dict.length = 258; codeLen = 9; prev = null; continue; }
    if (code === 257) { complete = true; break; }
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    for (let k = 0; k < entry.length; k++) out.push(entry[k]);
    if (prev) dict.push(prev.concat([entry[0]]));
    prev = entry;
    if (dict.length + (earlyChange ? 1 : 0) >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return { data: out.result(), complete: complete };
}

// ---------------------------------------------------------------------
// Crypto primitives for the Standard security handler: MD5, RC4,
// SHA-256/384/512 (64-bit words as 32-bit hi/lo pairs, ES2017 has no
// BigInt) and AES-CBC. Every function handles its whole input with the
// block code inlined - no user function calls per byte or block, because
// the Office Scripts runtime may turn each user call into an awaited call.
// ---------------------------------------------------------------------
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K: number[] = [];
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
// SHA-512 round constants and initial values as [hi, lo, hi, lo, ...]
const SHA512_K = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
];
const SHA512_H = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
];
const SHA384_H = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
];

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array, n: number): boolean {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function md5(data: Uint8Array): Uint8Array {
  if (MD5_K.length === 0) for (let i = 0; i < 64; i++) MD5_K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  const n = data.length;
  const end = (((n + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(end);
  buf.set(data);
  buf[n] = 0x80;
  const bitLo = (n * 8) >>> 0, bitHi = Math.floor(n / 536870912);
  buf[end - 8] = bitLo & 255; buf[end - 7] = (bitLo >>> 8) & 255; buf[end - 6] = (bitLo >>> 16) & 255; buf[end - 5] = bitLo >>> 24;
  buf[end - 4] = bitHi & 255; buf[end - 3] = (bitHi >>> 8) & 255; buf[end - 2] = (bitHi >>> 16) & 255; buf[end - 1] = bitHi >>> 24;
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < end; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
    }
    let a = h0, b = h1, c = h2, d = h3;
    for (let i = 0; i < 64; i++) {
      let f = 0, g = 0;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const x = (a + f + MD5_K[i] + M[g]) | 0;
      const s = MD5_S[i];
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
  }
  const out = new Uint8Array(16);
  const hs = [h0, h1, h2, h3];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = hs[i] & 255; out[i * 4 + 1] = (hs[i] >>> 8) & 255; out[i * 4 + 2] = (hs[i] >>> 16) & 255; out[i * 4 + 3] = hs[i] >>> 24;
  }
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const kl = key.length;
  if (kl === 0) { out.set(data); return out; }
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % kl]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

function sha256(data: Uint8Array): Uint8Array {
  const n = data.length;
  const end = (((n + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(end);
  buf.set(data);
  buf[n] = 0x80;
  const bitLo = (n * 8) >>> 0, bitHi = Math.floor(n / 536870912);
  buf[end - 1] = bitLo & 255; buf[end - 2] = (bitLo >>> 8) & 255; buf[end - 3] = (bitLo >>> 16) & 255; buf[end - 4] = bitLo >>> 24;
  buf[end - 5] = bitHi & 255; buf[end - 6] = (bitHi >>> 8) & 255; buf[end - 7] = (bitHi >>> 16) & 255; buf[end - 8] = bitHi >>> 24;
  const H = new Int32Array(8);
  for (let i = 0; i < 8; i++) H[i] = SHA256_H[i] | 0;
  const W = new Int32Array(64);
  for (let off = 0; off < end; off += 64) {
    for (let t = 0; t < 16; t++) {
      const p = off + t * 4;
      W[t] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15], w2 = W[t - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + SHA256_K[t] + W[t]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
  }
  return out;
}

function sha512(data: Uint8Array, is384: boolean): Uint8Array {
  // SHA-512, or SHA-384 when is384 (same compression, other IV, 48-byte output)
  const n = data.length;
  const end = (((n + 16) >>> 7) + 1) * 128;
  const buf = new Uint8Array(end);
  buf.set(data);
  buf[n] = 0x80;
  const bitLo = (n * 8) >>> 0, bitHi = Math.floor(n / 536870912);
  buf[end - 1] = bitLo & 255; buf[end - 2] = (bitLo >>> 8) & 255; buf[end - 3] = (bitLo >>> 16) & 255; buf[end - 4] = bitLo >>> 24;
  buf[end - 5] = bitHi & 255; buf[end - 6] = (bitHi >>> 8) & 255; buf[end - 7] = (bitHi >>> 16) & 255; buf[end - 8] = bitHi >>> 24;
  const IV = is384 ? SHA384_H : SHA512_H;
  const H = new Int32Array(16);
  for (let i = 0; i < 16; i++) H[i] = IV[i] | 0;
  const W = new Int32Array(160);
  for (let off = 0; off < end; off += 128) {
    for (let t = 0; t < 32; t++) {
      const p = off + t * 4;
      W[t] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    }
    for (let t = 16; t < 80; t++) {
      let xh = W[(t - 15) * 2], xl = W[(t - 15) * 2 + 1];
      // sigma0 = ROTR1 ^ ROTR8 ^ SHR7
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = W[(t - 2) * 2]; xl = W[(t - 2) * 2 + 1];
      // sigma1 = ROTR19 ^ ROTR61 ^ SHR6
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const lo = (s1l >>> 0) + (W[(t - 7) * 2 + 1] >>> 0) + (s0l >>> 0) + (W[(t - 16) * 2 + 1] >>> 0);
      W[t * 2] = (s1h + W[(t - 7) * 2] + s0h + W[(t - 16) * 2] + ((lo / 4294967296) >>> 0)) | 0;
      W[t * 2 + 1] = lo | 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let t = 0; t < 80; t++) {
      // T1 = h + Sigma1(e) + Ch(e, f, g) + K[t] + W[t]; Sigma1 = ROTR14 ^ ROTR18 ^ ROTR41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chooseH = (eh & fh) ^ (~eh & gh), chooseL = (el & fl) ^ (~el & gl);
      let lo = (hl >>> 0) + (S1l >>> 0) + (chooseL >>> 0) + (SHA512_K[t * 2 + 1] >>> 0) + (W[t * 2 + 1] >>> 0);
      const t1h = (hh + S1h + chooseH + SHA512_K[t * 2] + W[t * 2] + ((lo / 4294967296) >>> 0)) | 0, t1l = lo | 0;
      // T2 = Sigma0(a) + Maj(a, b, c); Sigma0 = ROTR28 ^ ROTR34 ^ ROTR39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majH = (ah & bh) ^ (ah & ch) ^ (bh & ch), majL = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l >>> 0) + (majL >>> 0);
      const t2h = (S0h + majH + ((lo / 4294967296) >>> 0)) | 0, t2l = lo | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      lo = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((lo / 4294967296) >>> 0)) | 0; el = lo | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      lo = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + ((lo / 4294967296) >>> 0)) | 0; al = lo | 0;
    }
    const R = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let i = 0; i < 16; i += 2) {
      const lo = (H[i + 1] >>> 0) + (R[i + 1] >>> 0);
      H[i] = (H[i] + R[i] + ((lo / 4294967296) >>> 0)) | 0;
      H[i + 1] = lo | 0;
    }
  }
  const outLen = is384 ? 48 : 64;
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen / 4; i++) {
    out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
  }
  return out;
}

// AES lookup tables: [enc T0..T3, sbox, dec T0..T3, inverse sbox], built once
let AES_T: Int32Array[] = [];

function aesTables(): Int32Array[] {
  if (AES_T.length > 0) return AES_T;
  const t: Int32Array[] = [];
  for (let i = 0; i < 10; i++) t.push(new Int32Array(256));
  const sbox = t[4], inv = t[9];
  const dbl = new Int32Array(256), third = new Int32Array(256);
  for (let i = 0; i < 256; i++) { dbl[i] = (i << 1) ^ ((i >> 7) * 283); third[dbl[i] ^ i] = i; }
  let x = 0, xInv = 0;
  for (let n = 0; n < 256; n++) {
    let s = xInv ^ (xInv << 1) ^ (xInv << 2) ^ (xInv << 3) ^ (xInv << 4);
    s = (s >> 8) ^ (s & 255) ^ 99;
    sbox[x] = s;
    inv[s] = x;
    const x2 = dbl[x], x4 = dbl[x2], x8 = dbl[x4];
    let tDec = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100);
    let tEnc = (dbl[s] * 0x101) ^ (s * 0x1010100);
    for (let i = 0; i < 4; i++) {
      tEnc = (tEnc << 24) ^ (tEnc >>> 8);
      t[i][x] = tEnc;
      tDec = (tDec << 24) ^ (tDec >>> 8);
      t[5 + i][s] = tDec;
    }
    x ^= x2 || 1;
    xInv = third[xInv] || 1;
  }
  AES_T = t;
  return t;
}

function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array, start: number, decrypt: boolean): Uint8Array {
  // AES-CBC (128/192/256-bit key) over data[start..], whole 16-byte blocks only, no padding handling.
  // decrypt=false encrypts (needed by the R6 password hash).
  const T = aesTables();
  const sbox = T[4];
  const nk = key.length >> 2;
  const total = 4 * nk + 28;
  const ek = new Int32Array(total);
  for (let i = 0; i < nk; i++) ek[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  let rcon = 1;
  for (let i = nk; i < total; i++) {
    let tmp = ek[i - 1];
    if (i % nk === 0 || (nk === 8 && i % nk === 4)) {
      tmp = (sbox[tmp >>> 24] << 24) ^ (sbox[(tmp >> 16) & 255] << 16) ^ (sbox[(tmp >> 8) & 255] << 8) ^ sbox[tmp & 255];
      if (i % nk === 0) {
        tmp = (tmp << 8) ^ (tmp >>> 24) ^ (rcon << 24);
        rcon = (rcon << 1) ^ ((rcon >> 7) * 283);
      }
    }
    ek[i] = ek[i - nk] ^ tmp;
  }
  let k = ek;
  if (decrypt) {
    const dk = new Int32Array(total);
    for (let j = 0, i = total; i > 0; j++, i--) {
      const tmp = ek[(j & 3) !== 0 ? i : i - 4];
      if (i <= 4 || j < 4) dk[j] = tmp;
      else dk[j] = T[5][sbox[tmp >>> 24]] ^ T[6][sbox[(tmp >> 16) & 255]] ^ T[7][sbox[(tmp >> 8) & 255]] ^ T[8][sbox[tmp & 255]];
    }
    k = dk;
  }
  const t0 = decrypt ? T[5] : T[0], t1 = decrypt ? T[6] : T[1], t2 = decrypt ? T[7] : T[2], t3 = decrypt ? T[8] : T[3];
  const sb = decrypt ? T[9] : T[4];
  const inner = total / 4 - 2;
  const len = Math.max(0, Math.floor((data.length - start) / 16) * 16);
  const out = new Uint8Array(len);
  let p0 = (iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3];
  let p1 = (iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7];
  let p2 = (iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11];
  let p3 = (iv[12] << 24) | (iv[13] << 16) | (iv[14] << 8) | iv[15];
  const o = new Int32Array(4);
  for (let off = 0; off < len; off += 16) {
    const s = start + off;
    let w0 = (data[s] << 24) | (data[s + 1] << 16) | (data[s + 2] << 8) | data[s + 3];
    let w1 = (data[s + 4] << 24) | (data[s + 5] << 16) | (data[s + 6] << 8) | data[s + 7];
    let w2 = (data[s + 8] << 24) | (data[s + 9] << 16) | (data[s + 10] << 8) | data[s + 11];
    let w3 = (data[s + 12] << 24) | (data[s + 13] << 16) | (data[s + 14] << 8) | data[s + 15];
    if (!decrypt) { w0 ^= p0; w1 ^= p1; w2 ^= p2; w3 ^= p3; }
    let a = w0 ^ k[0], b = (decrypt ? w3 : w1) ^ k[1], c = w2 ^ k[2], d = (decrypt ? w1 : w3) ^ k[3];
    let ki = 4;
    for (let r = 0; r < inner; r++) {
      const a2 = t0[a >>> 24] ^ t1[(b >> 16) & 255] ^ t2[(c >> 8) & 255] ^ t3[d & 255] ^ k[ki];
      const b2 = t0[b >>> 24] ^ t1[(c >> 16) & 255] ^ t2[(d >> 8) & 255] ^ t3[a & 255] ^ k[ki + 1];
      const c2 = t0[c >>> 24] ^ t1[(d >> 16) & 255] ^ t2[(a >> 8) & 255] ^ t3[b & 255] ^ k[ki + 2];
      d = t0[d >>> 24] ^ t1[(a >> 16) & 255] ^ t2[(b >> 8) & 255] ^ t3[c & 255] ^ k[ki + 3];
      ki += 4;
      a = a2; b = b2; c = c2;
    }
    for (let i = 0; i < 4; i++) {
      o[decrypt ? (3 & -i) : i] = (sb[a >>> 24] << 24) ^ (sb[(b >> 16) & 255] << 16) ^ (sb[(c >> 8) & 255] << 8) ^ sb[d & 255] ^ k[ki++];
      const tmp = a; a = b; b = c; c = d; d = tmp;
    }
    let r0 = o[0], r1 = o[1], r2 = o[2], r3 = o[3];
    if (decrypt) {
      r0 ^= p0; r1 ^= p1; r2 ^= p2; r3 ^= p3;
      p0 = w0; p1 = w1; p2 = w2; p3 = w3;
    } else {
      p0 = r0; p1 = r1; p2 = r2; p3 = r3;
    }
    out[off] = r0 >>> 24; out[off + 1] = (r0 >>> 16) & 255; out[off + 2] = (r0 >>> 8) & 255; out[off + 3] = r0 & 255;
    out[off + 4] = r1 >>> 24; out[off + 5] = (r1 >>> 16) & 255; out[off + 6] = (r1 >>> 8) & 255; out[off + 7] = r1 & 255;
    out[off + 8] = r2 >>> 24; out[off + 9] = (r2 >>> 16) & 255; out[off + 10] = (r2 >>> 8) & 255; out[off + 11] = r2 & 255;
    out[off + 12] = r3 >>> 24; out[off + 13] = (r3 >>> 16) & 255; out[off + 14] = (r3 >>> 8) & 255; out[off + 15] = r3 & 255;
  }
  return out;
}

function pdfPasswordHash(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array, r6: boolean): Uint8Array {
  // Hash for R5 (plain SHA-256) and R6 (ISO 32000-2 algorithm 2.B) security handlers
  let k = sha256(concatBytes([pw, salt, udata]));
  if (!r6) return k;
  for (let round = 1; round <= 320; round++) {
    const seq = pw.length + k.length + udata.length;
    const k1 = new Uint8Array(seq * 64);
    for (let r = 0; r < 64; r++) {
      const o = r * seq;
      k1.set(pw, o);
      k1.set(k, o + pw.length);
      k1.set(udata, o + pw.length + k.length);
    }
    const e = aesCbc(k.subarray(0, 16), k.subarray(16, 32), k1, 0, false);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    const m = sum % 3;
    k = m === 0 ? sha256(e) : sha512(e, m === 1);
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

// ---------------------------------------------------------------------
// Mail containers. Exchange stores a signed mail as ONE attachment "smime.p7m":
// clear-signed = the whole multipart/signed MIME entity as text, opaque-signed =
// CMS SignedData (DER or BER). The PDFs inside are read without any crypto (the
// signature is NOT verified). Encrypted S/MIME (CMS EnvelopedData) and Purview-
// protected mail (message.rpmsg) cannot be read and are only recognised.
// ---------------------------------------------------------------------
// container: the input is a mail container (MIME entity, CMS structure or .rpmsg);
// signed / encrypted / rpmsg: what was seen on the way; parts / berBudget: work limits; extraPdfs: PDFs beyond
// MAIL_MAX_PDFS (counted, not kept)
interface MailPdf { name: string; data: Uint8Array }
interface MailScan { pdfs: MailPdf[]; container: boolean; signed: boolean; encrypted: boolean; rpmsg: boolean; parts: number; berBudget: number; extraPdfs: number }
// one BER element: tag = first identifier byte, body = first content byte, end = after the element
// (including the end-of-contents octets of an indefinite length)
interface BerNode { tag: number; body: number; end: number; indef: boolean }
// header fields (lower-case names, folded lines joined); bodyStart: first body character; ok: a header block was found
interface MimeHead { fields: Map<string, string>; bodyStart: number; ok: boolean }
// a structured header value: "type/subtype" (lower case) and its parameters (lower-case names, raw values)
interface MimeValue { value: string; params: Map<string, string> }

const OID_PKCS7_DATA = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_ENVELOPED_DATA = "1.2.840.113549.1.7.3";
const OID_ENCRYPTED_DATA = "1.2.840.113549.1.7.6";
const OID_AUTH_ENVELOPED_DATA = "1.2.840.113549.1.9.16.1.23";
const OID_COMPRESSED_DATA = "1.2.840.113549.1.9.16.1.9";
const MAIL_MAX_DEPTH = 12;
const MAIL_MAX_PARTS = 5000;
const MAIL_MAX_PDFS = 50; // more PDFs are only counted (the duplicate check in mailResult compares every pair)

function decodeQuotedPrintable(s: string, start: number, end: number): Uint8Array {
  // quoted-printable (RFC 2045): "=XX" is one byte, "=" at the end of a line is a soft line break
  const out = new Uint8Array(Math.max(0, end - start));
  let o = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 61) { out[o++] = c & 0xff; continue; }
    let j = i + 1;
    while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j >= end) { i = j; continue; }
    const n1 = s.charCodeAt(j);
    if (n1 === 13 || n1 === 10) {
      i = n1 === 13 && j + 1 < end && s.charCodeAt(j + 1) === 10 ? j + 1 : j;
      continue;
    }
    const c1 = i + 1 < end ? s.charCodeAt(i + 1) : -1, c2 = i + 2 < end ? s.charCodeAt(i + 2) : -1;
    const h1 = c1 >= 48 && c1 <= 57 ? c1 - 48 : c1 >= 65 && c1 <= 70 ? c1 - 55 : c1 >= 97 && c1 <= 102 ? c1 - 87 : -1;
    const h2 = c2 >= 48 && c2 <= 57 ? c2 - 48 : c2 >= 65 && c2 <= 70 ? c2 - 55 : c2 >= 97 && c2 <= 102 ? c2 - 87 : -1;
    if (h1 >= 0 && h2 >= 0) { out[o++] = h1 * 16 + h2; i += 2; }
    else out[o++] = 61;
  }
  return out.subarray(0, o);
}

function utf8Decode(b: Uint8Array): string {
  // UTF-8 -> string (used for file names); an invalid sequence gives U+FFFD
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let cp = 0, n = 0;
    if (c < 0x80) { cp = c; n = 1; }
    else if (c >= 0xc2 && c < 0xe0) { cp = c & 0x1f; n = 2; }
    else if (c >= 0xe0 && c < 0xf0) { cp = c & 0x0f; n = 3; }
    else if (c >= 0xf0 && c < 0xf5) { cp = c & 0x07; n = 4; }
    let ok = n > 0 && i + n <= b.length;
    for (let k = 1; ok && k < n; k++) {
      const d = b[i + k];
      if ((d & 0xc0) !== 0x80) ok = false;
      else cp = cp * 64 + (d & 0x3f);
    }
    if (!ok) { out += "�"; i++; continue; }
    if (cp >= 0x10000) { const v = cp - 0x10000; out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); }
    else out += String.fromCharCode(cp);
    i += n;
  }
  return out;
}

function latin1Utf8(s: string): string {
  // header text whose raw bytes are UTF-8 (read one char per byte) -> decoded; anything else unchanged
  let high = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) return s;
    if (c >= 128) high = true;
  }
  if (!high) return s;
  const d = utf8Decode(latin1ToBytes(s));
  return d.indexOf("�") >= 0 ? s : d;
}

function charsetDecode(b: Uint8Array, charset: string): string {
  // UTF-8 when the charset says so, else one char per byte (ISO-8859-1 / Windows-1252 / ASCII)
  const cs = charset.toLowerCase();
  if (cs.indexOf("utf-8") >= 0 || cs.indexOf("utf8") >= 0) return utf8Decode(b);
  return bytesToLatin1(b, 0, b.length);
}

function percentDecode(s: string): Uint8Array {
  // RFC 2231 value: "%XX" is one byte
  const out = new Uint8Array(s.length);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37 && i + 2 < s.length) {
      const c1 = s.charCodeAt(i + 1), c2 = s.charCodeAt(i + 2);
      const h1 = c1 >= 48 && c1 <= 57 ? c1 - 48 : c1 >= 65 && c1 <= 70 ? c1 - 55 : c1 >= 97 && c1 <= 102 ? c1 - 87 : -1;
      const h2 = c2 >= 48 && c2 <= 57 ? c2 - 48 : c2 >= 65 && c2 <= 70 ? c2 - 55 : c2 >= 97 && c2 <= 102 ? c2 - 87 : -1;
      if (h1 >= 0 && h2 >= 0) { out[o++] = h1 * 16 + h2; i += 2; continue; }
    }
    out[o++] = c & 0xff;
  }
  return out.subarray(0, o);
}

function decodeMimeWords(v: string): string {
  // RFC 2047 encoded words "=?charset?B|Q?text?=" (white space between two words is dropped)
  let out = "";
  let p = 0;
  let lastWord = false;
  for (let guard = 0; p < v.length && guard < 1000; guard++) {
    const a = v.indexOf("=?", p);
    if (a < 0) { out += v.substring(p); break; }
    const q1 = v.indexOf("?", a + 2);
    const e = q1 >= 0 && q1 + 2 < v.length && v.charAt(q1 + 2) === "?" ? v.indexOf("?=", q1 + 3) : -1;
    const enc = q1 >= 0 ? v.charAt(q1 + 1).toUpperCase() : "";
    if (e < 0 || (enc !== "B" && enc !== "Q")) { out += v.substring(p, a + 2); p = a + 2; lastWord = false; continue; }
    const gap = v.substring(p, a);
    if (!lastWord || gap.trim() !== "") out += gap;
    let cs = v.substring(a + 2, q1);
    const star = cs.indexOf("*");
    if (star >= 0) cs = cs.substring(0, star);
    const txt = v.substring(q1 + 3, e);
    const bytes = enc === "B" ? decodeBase64Range(txt, 0, txt.length) : decodeQuotedPrintable(txt.split("_").join(" "), 0, txt.length);
    out += charsetDecode(bytes, cs);
    p = e + 2;
    lastWord = true;
  }
  return out;
}

function mimeValue(v: string): MimeValue {
  // "type/subtype; name=value; name2="quoted value"" -> value + parameters
  const params = new Map<string, string>();
  let i = v.indexOf(";");
  const main = (i < 0 ? v : v.substring(0, i)).trim().toLowerCase();
  for (let guard = 0; i >= 0 && i < v.length && guard < 200; guard++) {
    i++;
    const eq = v.indexOf("=", i);
    const semi = v.indexOf(";", i);
    if (eq < 0) break;
    if (semi >= 0 && semi < eq) { i = semi; continue; }
    const key = v.substring(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (j < v.length && (v.charCodeAt(j) === 32 || v.charCodeAt(j) === 9)) j++;
    let val = "";
    if (j < v.length && v.charCodeAt(j) === 34) {
      j++;
      let seg = j;
      while (j < v.length && v.charCodeAt(j) !== 34) {
        if (v.charCodeAt(j) === 92 && j + 1 < v.length) { val += v.substring(seg, j); j++; seg = j; }
        j++;
      }
      val += v.substring(seg, j);
      i = v.indexOf(";", j);
    } else {
      const e = v.indexOf(";", j);
      val = (e < 0 ? v.substring(j) : v.substring(j, e)).trim();
      i = e;
    }
    if (key !== "" && !params.has(key)) params.set(key, val);
  }
  return { value: main, params: params };
}

function mimeParam(mv: MimeValue, name: string): string {
  // a parameter with RFC 2231 (name*=utf-8''%XX, name*0*= / name*1= sections) and RFC 2047 decoding
  const p = mv.params;
  let joined = "";
  let charset = "";
  let found = false;
  for (let k = -1; k < 64; k++) {
    const enc = p.get(k < 0 ? name + "*" : name + "*" + k + "*");
    const raw = enc !== undefined ? enc : k < 0 ? undefined : p.get(name + "*" + k);
    if (raw === undefined) { if (k < 0) continue; break; }
    found = true;
    if (enc !== undefined) {
      let t = enc;
      if (k <= 0) {
        const q = t.indexOf("'"), q2 = q >= 0 ? t.indexOf("'", q + 1) : -1;
        if (q2 > q) { charset = t.substring(0, q); t = t.substring(q2 + 1); }
      }
      const b = percentDecode(t);
      joined += bytesToLatin1(b, 0, b.length);
    } else joined += raw;
    if (k < 0) break;
  }
  if (found) return charset !== "" ? charsetDecode(latin1ToBytes(joined), charset) : latin1Utf8(joined);
  const plain = p.get(name);
  return plain === undefined ? "" : decodeMimeWords(latin1Utf8(plain));
}

function mimeHeaders(s: string, start: number, end: number): MimeHead {
  // header block of the entity s[start, end): field lines up to the first empty line
  const fields = new Map<string, string>();
  const lim = Math.min(end, start + 65536);
  let p = start;
  let curName = "", curVal = "";
  let count = 0;
  while (p < lim) {
    let e = s.indexOf("\n", p);
    if (e < 0 || e > end) e = end;
    const le = e > p && s.charCodeAt(e - 1) === 13 ? e - 1 : e;
    if (le === p) {
      if (curName !== "" && !fields.has(curName)) fields.set(curName, curVal);
      return { fields: fields, bodyStart: Math.min(e + 1, end), ok: true };
    }
    const c = s.charCodeAt(p);
    if ((c === 32 || c === 9) && count > 0) {
      curVal += " " + s.substring(p, le).trim();
    } else {
      const colon = s.indexOf(":", p);
      let good = colon > p && colon < le;
      for (let k = p; good && k < colon; k++) { const d = s.charCodeAt(k); if (d <= 32 || d >= 127) good = false; }
      if (!good) {
        // an mbox "From " line before the headers is tolerated
        if (count === 0 && s.substring(p, p + 5) === "From ") { p = e + 1; continue; }
        return { fields: fields, bodyStart: start, ok: false };
      }
      if (curName !== "" && !fields.has(curName)) fields.set(curName, curVal);
      curName = s.substring(p, colon).toLowerCase();
      curVal = s.substring(colon + 1, le).trim();
      count++;
    }
    p = e + 1;
  }
  if (curName !== "" && !fields.has(curName)) fields.set(curName, curVal);
  return { fields: fields, bodyStart: Math.min(p, end), ok: count > 0 && p >= end };
}

function mimeParts(s: string, start: number, end: number, boundary: string): number[] {
  // body parts of a multipart body as [start0, end0, start1, end1, ...]; a part cut off by the end
  // of the data (no closing delimiter) is kept
  const out: number[] = [];
  const delim = "--" + boundary;
  let p = start;
  let partStart = -1;
  for (let guard = 0; p < end && guard < 20000; guard++) {
    const i = s.indexOf(delim, p);
    if (i < 0 || i + delim.length > end) break;
    let j = i + delim.length;
    if (i !== start && s.charCodeAt(i - 1) !== 10) { p = j; continue; }
    const close = j + 1 < end && s.charCodeAt(j) === 45 && s.charCodeAt(j + 1) === 45;
    if (close) j += 2;
    while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (!close && j < end && s.charCodeAt(j) !== 13 && s.charCodeAt(j) !== 10) { p = i + delim.length; continue; }
    if (partStart >= 0) {
      let pe = i;
      if (pe > partStart && s.charCodeAt(pe - 1) === 10) pe--;
      if (pe > partStart && s.charCodeAt(pe - 1) === 13) pe--;
      out.push(partStart, pe);
    }
    if (close) return out;
    if (j < end && s.charCodeAt(j) === 13) j++;
    if (j < end && s.charCodeAt(j) === 10) j++;
    partStart = j;
    p = j;
  }
  if (partStart >= 0 && partStart < end) out.push(partStart, end);
  return out;
}

function guessBoundary(s: string, start: number, end: number): string {
  // multipart body without headers: the first "--boundary" line (within 16 KB) that occurs again later
  let p = start;
  let tries = 0;
  for (let lines = 0; p < end && p < start + 16384 && lines < 400 && tries < 8; lines++) {
    let e = s.indexOf("\n", p);
    if (e < 0 || e > end) e = end;
    let le = e;
    while (le > p && s.charCodeAt(le - 1) <= 32) le--;
    if (le - p > 2 && le - p <= 202 && s.charCodeAt(p) === 45 && s.charCodeAt(p + 1) === 45) {
      tries++;
      const b = s.substring(p + 2, le);
      const again = s.indexOf("\n--" + b, e);
      if (b.charCodeAt(0) > 32 && again >= 0 && again < end) return b;
    }
    p = e + 1;
  }
  return "";
}

function mimeBody(s: string, start: number, end: number, cte: string): Uint8Array {
  // body bytes after the Content-Transfer-Encoding
  if (cte === "base64") return decodeBase64Range(s, start, end);
  if (cte === "quoted-printable") return decodeQuotedPrintable(s, start, end);
  return latin1ToBytes(s.substring(start, end));
}

function berNode(b: Uint8Array, p: number, limit: number, depth: number, st: MailScan): BerNode | null {
  // one BER/DER element at p (definite or indefinite length); null when malformed or truncated
  if (depth > 40 || p + 2 > limit || --st.berBudget < 0) return null;
  const tag = b[p];
  let q = p + 1;
  if ((tag & 0x1f) === 0x1f) {
    while (q < limit && (b[q] & 0x80) !== 0) q++;
    q++;
  }
  if (q >= limit) return null;
  const l0 = b[q++];
  if (l0 === 0x80) {
    if ((tag & 0x20) === 0) return null;
    let r = q;
    while (r + 2 <= limit) {
      if (b[r] === 0 && b[r + 1] === 0) return { tag: tag, body: q, end: r + 2, indef: true };
      const c = berNode(b, r, limit, depth + 1, st);
      if (c === null) return null;
      r = c.end;
    }
    return null;
  }
  let len = l0;
  if (l0 > 0x80) {
    const n = l0 & 0x7f;
    if (n > 4 || q + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[q++];
  }
  if (len > limit - q) return null;
  return { tag: tag, body: q, end: q + len, indef: false };
}

function berChildren(b: Uint8Array, node: BerNode, st: MailScan): BerNode[] {
  // the elements inside a constructed element (stops at the first malformed one)
  const out: BerNode[] = [];
  const stop = node.indef ? node.end - 2 : node.end;
  let p = node.body;
  while (p < stop && out.length < 200000) {
    const c = berNode(b, p, stop, 0, st);
    if (c === null) break;
    out.push(c);
    p = c.end;
  }
  return out;
}

function berOctets(b: Uint8Array, node: BerNode, st: MailScan, pieces: Uint8Array[], depth: number): boolean {
  // content of an OCTET STRING: primitive, or constructed from (nested) chunks as BER encoders write it
  if ((node.tag & 0x20) === 0) { pieces.push(b.subarray(node.body, node.end)); return true; }
  if (depth > 8) return false;
  const kids = berChildren(b, node, st);
  for (const k of kids) if (!berOctets(b, k, st, pieces, depth + 1)) return false;
  return true;
}

function berOid(b: Uint8Array, node: BerNode): string {
  // OBJECT IDENTIFIER -> dotted string
  let out = "";
  let v = 0;
  let first = true;
  for (let i = node.body; i < node.end && i < node.body + 64; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if ((b[i] & 0x80) !== 0) continue;
    if (first) { const a = v < 80 ? Math.floor(v / 40) : 2; out = a + "." + (v - a * 40); first = false; }
    else out += "." + v;
    v = 0;
  }
  return out;
}

function joinPieces(pieces: Uint8Array[]): Uint8Array {
  // one chunk is used as it is (no copy of a large primitive OCTET STRING)
  return pieces.length === 1 ? pieces[0] : concatBytes(pieces);
}

function scanCms(b: Uint8Array, depth: number, st: MailScan): boolean {
  // b is a CMS ContentInfo (DER or BER): opened and true; false when b is not CMS
  const root = berNode(b, 0, b.length, 0, st);
  if (root === null || root.tag !== 0x30) return false;
  const kids = berChildren(b, root, st);
  if (kids.length < 1 || kids[0].tag !== 0x06) return false;
  const oid = berOid(b, kids[0]);
  if (oid.indexOf("1.2.840.113549.1.") !== 0) return false;
  st.container = true;
  let content: BerNode | null = null;
  if (kids.length > 1 && kids[1].tag === 0xa0) {
    const ck = berChildren(b, kids[1], st);
    if (ck.length > 0) content = ck[0];
  }
  cmsContent(b, oid, content, depth, st);
  return true;
}

function cmsContent(b: Uint8Array, oid: string, node: BerNode | null, depth: number, st: MailScan): void {
  // content of one CMS type: SignedData / CompressedData / Data are opened, encrypted types only flagged
  if (oid === OID_ENVELOPED_DATA || oid === OID_AUTH_ENVELOPED_DATA || oid === OID_ENCRYPTED_DATA) { st.encrypted = true; return; }
  if (node === null || depth > MAIL_MAX_DEPTH) return;
  let data: Uint8Array | null = null;
  let innerType = OID_PKCS7_DATA;
  if (oid === OID_PKCS7_DATA) {
    const pieces: Uint8Array[] = [];
    if (berOctets(b, node, st, pieces, 0)) data = joinPieces(pieces);
  } else if (oid === OID_SIGNED_DATA || oid === OID_COMPRESSED_DATA) {
    if (oid === OID_SIGNED_DATA) st.signed = true;
    // both start with: version, digest / compression algorithm(s), encapContentInfo { eContentType, [0] eContent }
    const sk: BerNode[] = node.tag === 0x30 ? berChildren(b, node, st) : [];
    if (sk.length < 3 || sk[2].tag !== 0x30) return;
    const eci = berChildren(b, sk[2], st);
    if (eci.length < 2 || eci[0].tag !== 0x06 || eci[1].tag !== 0xa0) return; // detached signature: no content
    innerType = berOid(b, eci[0]);
    const ek = berChildren(b, eci[1], st);
    const pieces: Uint8Array[] = [];
    if (ek.length < 1 || !berOctets(b, ek[0], st, pieces, 0)) return;
    data = joinPieces(pieces);
    if (oid === OID_COMPRESSED_DATA) {
      try { data = inflate(data).data; } catch (e) { return; }
    }
  } else return;
  if (data === null || data.length === 0) return;
  if (innerType === OID_PKCS7_DATA) { scanMailBytes(data, "", depth + 1, st); return; }
  // a nested CMS type is encapsulated without its ContentInfo
  const inner = berNode(data, 0, data.length, 0, st);
  if (inner !== null) cmsContent(data, innerType, inner, depth + 1, st);
}

function scanMailBytes(b: Uint8Array, name: string, depth: number, st: MailScan): void {
  // one decoded body: a PDF, a CMS structure, an .rpmsg file, PEM / base64 text of these, or a MIME entity
  if (depth > MAIL_MAX_DEPTH || ++st.parts > MAIL_MAX_PARTS || b.length < 4) return;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    if (st.pdfs.length < MAIL_MAX_PDFS) st.pdfs.push({ name: name, data: b });
    else st.extraPdfs++;
    return;
  }
  if (b.length >= 8 && b[0] === 0x76 && b[1] === 0xe8 && b[2] === 0x04 && b[3] === 0x60 && b[4] === 0xc4 && b[5] === 0x11 && b[6] === 0xe3 && b[7] === 0x86) {
    st.rpmsg = true;
    st.container = true;
    return;
  }
  if (b[0] === 0x30 && scanCms(b, depth, st)) return;
  const head = bytesToLatin1(b, 0, Math.min(b.length, 2048));
  let p = 0;
  while (p < head.length && head.charCodeAt(p) <= 32) p++;
  if (head.substring(p, p + 11) === "-----BEGIN ") {
    const s = bytesToLatin1(b, 0, b.length);
    const from = s.indexOf("\n", p);
    const stop = s.indexOf("-----END", p + 11);
    if (from > 0 && stop > from) scanMailBytes(decodeBase64Range(s, from + 1, stop), name, depth + 1, st);
    return;
  }
  if (head.length - p >= 16 && /^[A-Za-z0-9+\/=\s]+$/.test(head)) {
    const s = bytesToLatin1(b, 0, b.length);
    scanMailBytes(decodeBase64Range(s, 0, s.length), name, depth + 1, st);
    return;
  }
  const s = bytesToLatin1(b, 0, b.length);
  scanMimeEntity(s, 0, s.length, depth, st, true);
}

function scanMultipart(s: string, start: number, end: number, boundary: string, type: string, depth: number, st: MailScan): void {
  // body parts of a multipart entity; in multipart/signed only the first part is content (the second is the signature)
  const parts = mimeParts(s, start, end, boundary);
  let signed = type === "multipart/signed";
  if (!signed && type === "" && parts.length >= 4) {
    const lh = mimeHeaders(s, parts[parts.length - 2], parts[parts.length - 1]);
    const lct = lh.ok ? (lh.fields.get("content-type") || "").toLowerCase() : "";
    signed = lct.indexOf("signature") >= 0;
  }
  if (signed) st.signed = true;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    scanMimeEntity(s, parts[i], parts[i + 1], depth + 1, st, false);
    if (signed) break;
  }
}

function scanMimeEntity(s: string, start: number, end: number, depth: number, st: MailScan, top: boolean): void {
  // a MIME entity in s[start, end); top: also accept a header-less multipart body (preamble / first boundary)
  if (depth > MAIL_MAX_DEPTH || ++st.parts > MAIL_MAX_PARTS) return;
  const h = mimeHeaders(s, start, end);
  const ctRaw = h.ok ? (h.fields.get("content-type") || "") : "";
  if (ctRaw === "") {
    if (!top) return;
    const from = h.ok ? h.bodyStart : start;
    const bnd = guessBoundary(s, from, end);
    if (bnd !== "") { st.container = true; scanMultipart(s, from, end, bnd, "", depth, st); }
    return;
  }
  st.container = true;
  const ct = mimeValue(ctRaw);
  const type = ct.value;
  const cte = (h.fields.get("content-transfer-encoding") || "").trim().toLowerCase();
  let name = mimeParam(mimeValue(h.fields.get("content-disposition") || ""), "filename");
  if (name === "") name = mimeParam(ct, "name");
  const lname = name.toLowerCase();
  const b0 = h.bodyStart;
  if (type.indexOf("multipart/") === 0) {
    let bnd = ct.params.get("boundary") || "";
    if (bnd === "") bnd = guessBoundary(s, b0, end);
    if (bnd !== "") scanMultipart(s, b0, end, bnd, type, depth, st);
    return;
  }
  if (type === "message/rfc822" || type === "message/global" || lname.endsWith(".eml")) {
    if (cte === "base64" || cte === "quoted-printable") scanMailBytes(mimeBody(s, b0, end, cte), name, depth + 1, st);
    else scanMimeEntity(s, b0, end, depth + 1, st, false);
    return;
  }
  if (type === "application/x-microsoft-rpmsg-message" || lname.endsWith(".rpmsg")) { st.rpmsg = true; return; }
  if (type === "application/pkcs7-mime" || type === "application/x-pkcs7-mime" || lname.endsWith(".p7m")) {
    const sm = (ct.params.get("smime-type") || "").toLowerCase();
    if (sm === "enveloped-data" || sm === "authenveloped-data") { st.encrypted = true; return; }
    scanMailBytes(mimeBody(s, b0, end, cte), name, depth + 1, st);
    return;
  }
  const pdfType = type === "application/pdf" || type === "application/x-pdf" || lname.endsWith(".pdf");
  if (!pdfType) {
    // other attachments count only when their content is a PDF ("JVBER" = base64 of "%PDF")
    let q = b0;
    while (q < end && s.charCodeAt(q) <= 32) q++;
    if (type.indexOf("text/") === 0 || s.substring(q, q + (cte === "base64" ? 5 : 4)) !== (cte === "base64" ? "JVBER" : "%PDF")) return;
  }
  const data = mimeBody(s, b0, end, cte);
  // a few junk bytes before the header are tolerated, as for a PDF passed directly
  const lim = Math.min(data.length - 5, 1024);
  for (let i = 0; i <= lim; i++) {
    if (data[i] === 0x25 && data[i + 1] === 0x50 && data[i + 2] === 0x44 && data[i + 3] === 0x46) {
      if (st.pdfs.length < MAIL_MAX_PDFS) st.pdfs.push({ name: name, data: i > 0 ? data.subarray(i) : data });
      else st.extraPdfs++;
      return;
    }
  }
}

function unwrapMail(b: Uint8Array): MailScan {
  // PDFs inside a mail container (smime.p7m / .eml / base64 or PEM CMS); flags for encrypted / protected mail
  const st: MailScan = { pdfs: [], container: false, signed: false, encrypted: false, rpmsg: false, parts: 0, berBudget: 4000000, extraPdfs: 0 };
  scanMailBytes(b, "", 0, st);
  return st;
}

// ---- generated tables (encodings as Unicode code points, 0 = undefined) ----
const ENC_WINANSI: number[] = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,
  96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,8226,
  8364,8226,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,8226,381,8226,8226,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,8226,382,376,
  32,161,162,163,164,165,166,167,168,169,170,171,172,45,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,
  192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,
  224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,
];

const ENC_MACROMAN: number[] = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,
  96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,0,
  196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,239,241,243,242,244,246,245,250,249,251,252,
  8224,176,162,163,167,8226,182,223,174,169,8482,180,168,0,198,216,0,177,0,0,165,181,0,0,0,0,0,170,186,0,230,248,
  191,161,172,0,402,0,0,171,187,8230,32,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,0,255,376,8260,164,8249,8250,64257,64258,
  8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,0,210,218,219,217,305,710,732,175,728,729,730,184,733,731,711,
];

const ENC_STANDARD: number[] = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  32,33,34,35,36,37,38,8217,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,
  8216,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,161,162,163,8260,165,402,167,164,39,8220,171,8249,8250,64257,64258,0,8211,8224,8225,183,0,182,8226,8218,8222,8221,187,8230,8240,0,191,
  0,96,180,710,732,175,728,729,168,0,730,184,0,733,731,711,8212,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,198,0,170,0,0,0,0,321,216,338,186,0,0,0,0,0,230,0,0,0,305,0,0,322,248,339,223,0,0,0,0,
];

const GLYPHS: {[name: string]: number} = {
  A:65,AE:198,AEsmall:63462,Aacute:193,Aacutesmall:63457,Abreve:258,Acircumflex:194,Acircumflexsmall:63458,
  Acutesmall:63412,Adieresis:196,Adieresissmall:63460,Agrave:192,Agravesmall:63456,Alpha:913,Amacron:256,
  Aogonek:260,Aring:197,Aringsmall:63461,Asmall:63329,Atilde:195,Atildesmall:63459,B:66,Beta:914,
  Brevesmall:63220,Bsmall:63330,C:67,Cacute:262,Caronsmall:63221,Ccaron:268,Ccedilla:199,Ccedillasmall:63463,
  Cedillasmall:63416,Chi:935,Circumflexsmall:63222,Csmall:63331,D:68,Dcaron:270,Dcroat:272,Delta:8710,
  Dieresissmall:63400,Dotaccentsmall:63223,Dsmall:63332,E:69,Eacute:201,Eacutesmall:63465,Ecaron:282,
  Ecircumflex:202,Ecircumflexsmall:63466,Edieresis:203,Edieresissmall:63467,Edotaccent:278,Egrave:200,
  Egravesmall:63464,Emacron:274,Eogonek:280,Epsilon:917,Esmall:63333,Eta:919,Eth:208,Ethsmall:63472,Euro:8364,
  F:70,Fsmall:63334,G:71,Gamma:915,Gbreve:286,Gcommaaccent:290,Gravesmall:63328,Gsmall:63335,H:72,
  Hsmall:63336,Hungarumlautsmall:63224,I:73,Iacute:205,Iacutesmall:63469,Icircumflex:206,
  Icircumflexsmall:63470,Idieresis:207,Idieresissmall:63471,Idotaccent:304,Ifraktur:8465,Igrave:204,
  Igravesmall:63468,Imacron:298,Iogonek:302,Iota:921,Ismall:63337,J:74,Jsmall:63338,K:75,Kappa:922,
  Kcommaaccent:310,Ksmall:63339,L:76,Lacute:313,Lambda:923,Lcaron:317,Lcommaaccent:315,Lslash:321,
  Lslashsmall:63225,Lsmall:63340,M:77,Macronsmall:63407,Msmall:63341,Mu:924,N:78,Nacute:323,Ncaron:327,
  Ncommaaccent:325,Nsmall:63342,Ntilde:209,Ntildesmall:63473,Nu:925,O:79,OE:338,OEsmall:63226,Oacute:211,
  Oacutesmall:63475,Ocircumflex:212,Ocircumflexsmall:63476,Odieresis:214,Odieresissmall:63478,
  Ogoneksmall:63227,Ograve:210,Ogravesmall:63474,Ohungarumlaut:336,Omacron:332,Omega:8486,Omicron:927,
  Oslash:216,Oslashsmall:63480,Osmall:63343,Otilde:213,Otildesmall:63477,P:80,Phi:934,Pi:928,Psi:936,
  Psmall:63344,Q:81,Qsmall:63345,R:82,Racute:340,Rcaron:344,Rcommaaccent:342,Rfraktur:8476,Rho:929,
  Ringsmall:63228,Rsmall:63346,S:83,Sacute:346,Scaron:352,Scaronsmall:63229,Scedilla:350,Scommaaccent:536,
  Sigma:931,Ssmall:63347,T:84,Tau:932,Tcaron:356,Tcommaaccent:354,Theta:920,Thorn:222,Thornsmall:63486,
  Tildesmall:63230,Tsmall:63348,U:85,Uacute:218,Uacutesmall:63482,Ucircumflex:219,Ucircumflexsmall:63483,
  Udieresis:220,Udieresissmall:63484,Ugrave:217,Ugravesmall:63481,Uhungarumlaut:368,Umacron:362,Uogonek:370,
  Upsilon:933,Upsilon1:978,Uring:366,Usmall:63349,V:86,Vsmall:63350,W:87,Wsmall:63351,X:88,Xi:926,
  Xsmall:63352,Y:89,Yacute:221,Yacutesmall:63485,Ydieresis:376,Ydieresissmall:63487,Ysmall:63353,Z:90,
  Zacute:377,Zcaron:381,Zcaronsmall:63231,Zdotaccent:379,Zeta:918,Zsmall:63354,a:97,aacute:225,abreve:259,
  acircumflex:226,acute:180,adieresis:228,ae:230,agrave:224,aleph:8501,alpha:945,amacron:257,ampersand:38,
  ampersandsmall:63270,angle:8736,angleleft:9001,angleright:9002,aogonek:261,apple:63743,approxequal:8776,
  aring:229,arrowboth:8596,arrowdblboth:8660,arrowdbldown:8659,arrowdblleft:8656,arrowdblright:8658,
  arrowdblup:8657,arrowdown:8595,arrowhorizex:63719,arrowleft:8592,arrowright:8594,arrowup:8593,
  arrowvertex:63718,asciicircum:94,asciitilde:126,asterisk:42,asteriskmath:8727,asuperior:63209,at:64,
  atilde:227,b:98,backslash:92,bar:124,beta:946,braceex:63732,braceleft:123,braceleftbt:63731,
  braceleftmid:63730,bracelefttp:63729,braceright:125,bracerightbt:63742,bracerightmid:63741,
  bracerighttp:63740,bracketleft:91,bracketleftbt:63728,bracketleftex:63727,bracketlefttp:63726,
  bracketright:93,bracketrightbt:63739,bracketrightex:63738,bracketrighttp:63737,breve:728,brokenbar:166,
  bsuperior:63210,bullet:8226,bulletoperator:8729,c:99,cacute:263,caron:711,carriagereturn:8629,ccaron:269,
  ccedilla:231,cedilla:184,cent:162,centinferior:63199,centoldstyle:63394,centsuperior:63200,checkmark:10003,
  chi:967,circlemultiply:8855,circleplus:8853,circumflex:710,club:9827,colon:58,colonmonetary:8353,comma:44,
  commainferior:63201,commasuperior:63202,congruent:8773,copyright:169,copyrightsans:63721,
  copyrightserif:63193,currency:164,d:100,dagger:8224,daggerdbl:8225,dcaron:271,dcroat:273,degree:176,
  delta:948,diamond:9830,dieresis:168,divide:247,dollar:36,dollarinferior:63203,dollaroldstyle:63268,
  dollarsuperior:63204,dotaccent:729,dotlessi:305,dotmath:8901,dsuperior:63211,e:101,eacute:233,ecaron:283,
  ecircumflex:234,edieresis:235,edotaccent:279,egrave:232,eight:56,eightinferior:8328,eightoldstyle:63288,
  eightsuperior:8312,element:8712,ellipsis:8230,emacron:275,emdash:8212,emptyset:8709,endash:8211,eogonek:281,
  epsilon:949,equal:61,equivalence:8801,esuperior:63212,eta:951,eth:240,euro:8364,exclam:33,exclamdown:161,
  exclamdownsmall:63393,exclamsmall:63265,existential:8707,f:102,ff:64256,ffi:64259,ffl:64260,fi:64257,
  figuredash:8210,five:53,fiveeighths:8541,fiveinferior:8325,fiveoldstyle:63285,fivesuperior:8309,fl:64258,
  florin:402,four:52,fourinferior:8324,fouroldstyle:63284,foursuperior:8308,fraction:8260,g:103,gamma:947,
  gbreve:287,gcommaaccent:291,germandbls:223,gradient:8711,grave:96,greater:62,greaterequal:8805,
  guillemotleft:171,guillemotright:187,guilsinglleft:8249,guilsinglright:8250,h:104,heart:9829,
  hungarumlaut:733,hyphen:45,hypheninferior:63205,hyphensuperior:63206,i:105,iacute:237,icircumflex:238,
  idieresis:239,igrave:236,imacron:299,infinity:8734,integral:8747,integralbt:8993,integralex:63733,
  integraltp:8992,intersection:8745,iogonek:303,iota:953,isuperior:63213,j:106,k:107,kappa:954,
  kcommaaccent:311,l:108,lacute:314,lambda:955,lcaron:318,lcommaaccent:316,less:60,lessequal:8804,
  logicaland:8743,logicalnot:172,logicalor:8744,lozenge:9674,lslash:322,lsuperior:63214,m:109,macron:175,
  middot:183,minus:8722,minute:8242,msuperior:63215,mu:181,multiply:215,n:110,nacute:324,nbspace:160,
  ncaron:328,ncommaaccent:326,nine:57,nineinferior:8329,nineoldstyle:63289,ninesuperior:8313,
  nonbreakingspace:160,notelement:8713,notequal:8800,notsubset:8836,nsuperior:8319,ntilde:241,nu:957,
  numbersign:35,o:111,oacute:243,ocircumflex:244,odieresis:246,oe:339,ogonek:731,ograve:242,ohungarumlaut:337,
  omacron:333,omega:969,omega1:982,omicron:959,one:49,onedotenleader:8228,oneeighth:8539,onefitted:63196,
  onehalf:189,oneinferior:8321,oneoldstyle:63281,onequarter:188,onesuperior:185,onethird:8531,ordfeminine:170,
  ordmasculine:186,oslash:248,osuperior:63216,otilde:245,p:112,paragraph:182,parenleft:40,parenleftbt:63725,
  parenleftex:63724,parenleftinferior:8333,parenleftsuperior:8317,parenlefttp:63723,parenright:41,
  parenrightbt:63736,parenrightex:63735,parenrightinferior:8334,parenrightsuperior:8318,parenrighttp:63734,
  partialdiff:8706,percent:37,period:46,periodcentered:183,periodinferior:63207,periodsuperior:63208,
  perpendicular:8869,perthousand:8240,phi:966,phi1:981,pi:960,plus:43,plusminus:177,product:8719,
  propersubset:8834,propersuperset:8835,proportional:8733,psi:968,q:113,question:63,questiondown:191,
  questiondownsmall:63423,questionsmall:63295,quotedbl:34,quotedblbase:8222,quotedblleft:8220,
  quotedblright:8221,quoteleft:8216,quoteright:8217,quotesinglbase:8218,quotesingle:39,r:114,racute:341,
  radical:8730,radicalex:63717,rcaron:345,rcommaaccent:343,reflexsubset:8838,reflexsuperset:8839,
  registered:174,registersans:63720,registerserif:63194,rho:961,ring:730,rsuperior:63217,rupiah:63197,s:115,
  sacute:347,scaron:353,scedilla:351,scommaaccent:537,second:8243,section:167,semicolon:59,seven:55,
  seveneighths:8542,seveninferior:8327,sevenoldstyle:63287,sevensuperior:8311,sfthyphen:173,sigma:963,
  sigma1:962,similar:8764,six:54,sixinferior:8326,sixoldstyle:63286,sixsuperior:8310,slash:47,softhyphen:173,
  space:32,spade:9824,ssuperior:63218,sterling:163,suchthat:8715,summation:8721,t:116,tau:964,tcaron:357,
  tcommaaccent:355,therefore:8756,theta:952,theta1:977,thorn:254,three:51,threeeighths:8540,
  threeinferior:8323,threeoldstyle:63283,threequarters:190,threequartersemdash:63198,threesuperior:179,
  tilde:732,trademark:8482,trademarksans:63722,trademarkserif:63195,tsuperior:63219,two:50,
  twodotenleader:8229,twoinferior:8322,twooldstyle:63282,twosuperior:178,twothirds:8532,u:117,uacute:250,
  ucircumflex:251,udieresis:252,ugrave:249,uhungarumlaut:369,umacron:363,underscore:95,union:8746,
  universal:8704,uogonek:371,upsilon:965,uring:367,v:118,w:119,weierstrass:8472,x:120,xi:958,y:121,yacute:253,
  ydieresis:255,yen:165,z:122,zacute:378,zcaron:382,zdotaccent:380,zero:48,zeroinferior:8320,
  zerooldstyle:63280,zerosuperior:8304,zeta:950,
};

const W_HELV: number[] = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,
  556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,
  278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,
  667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,
  556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500,
];

const W_HELVB: number[] = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,
  556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,
  278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,
  722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,
  556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556,
];

const W_TIMES: number[] = [
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,
  921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,
  333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,350,
  500,350,333,500,444,1000,500,500,333,1000,556,333,889,350,611,350,350,333,333,444,444,350,500,1000,333,980,389,333,722,350,444,722,
  250,333,500,500,500,500,200,500,333,760,276,500,564,333,760,333,400,564,300,300,333,500,453,250,333,300,310,500,750,750,750,444,
  722,722,722,722,722,722,889,667,611,611,611,611,333,333,333,333,722,722,722,722,722,722,722,564,722,722,722,722,722,722,556,500,
  444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,500,564,500,500,500,500,500,500,500,500,
];

const W_TIMESB: number[] = [
  250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,
  930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,
  333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,350,
  500,350,333,500,500,1000,500,500,333,1000,556,333,1000,350,667,350,350,333,333,500,500,350,500,1000,333,1000,389,333,722,350,444,722,
  250,333,500,500,500,500,220,500,333,747,300,500,570,333,747,333,400,570,300,300,333,556,540,250,333,300,330,500,750,750,750,500,
  722,722,722,722,722,722,1000,722,667,667,667,667,389,389,389,389,722,722,778,778,778,778,778,570,778,722,722,722,722,722,611,556,
  500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,500,570,500,556,556,556,556,500,556,500,
];

// ---------------------------------------------------------------------
// PDF object model
// ---------------------------------------------------------------------
interface PName { t: "name"; v: string }
interface PStr { t: "str"; v: string }          // latin1 (one char per byte)
interface PRef { t: "ref"; n: number; g: number }
interface PArr { t: "arr"; v: PObj[] }
interface PDict { t: "dict"; m: Map<string, PObj> }
interface PKw { t: "kw"; v: string }            // keyword / content-stream operator
// n/g: object and generation number (key for decryption); start: offset of the data in the file;
// exactLen: raw was cut by a direct /Length (false = cut at "endstream", may be refined later)
interface PStream { t: "stream"; d: PDict; raw: string; id: number; n: number; g: number; start: number; exactLen: boolean }
type PObj = number | boolean | null | PName | PStr | PRef | PArr | PDict | PKw | PStream;

function isName(o: PObj): o is PName { return typeof o === "object" && o !== null && o.t === "name"; }
function isStr(o: PObj): o is PStr { return typeof o === "object" && o !== null && o.t === "str"; }
function isRef(o: PObj): o is PRef { return typeof o === "object" && o !== null && o.t === "ref"; }
function isArr(o: PObj): o is PArr { return typeof o === "object" && o !== null && o.t === "arr"; }
function isDict(o: PObj): o is PDict { return typeof o === "object" && o !== null && o.t === "dict"; }
function isKw(o: PObj): o is PKw { return typeof o === "object" && o !== null && o.t === "kw"; }
function isStream(o: PObj): o is PStream { return typeof o === "object" && o !== null && o.t === "stream"; }
function isNum(o: PObj): o is number { return typeof o === "number"; }

function mkName(v: string): PName { return { t: "name", v: v }; }
function mkDict(): PDict { return { t: "dict", m: new Map<string, PObj>() }; }

function isWs(c: number): boolean {
  // PDF white space (character classes)
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}
function isDelim(c: number): boolean {
  // ( ) < > [ ] { } / %
  return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
}
function isRegular(c: number): boolean {
  return !isWs(c) && !isDelim(c);
}

// ---------------------------------------------------------------------
// Lexer / parser over a latin1 string
// ---------------------------------------------------------------------
// Lexer.unterminated: a literal string ran to the end of the input
class Lexer {
  s: string;
  pos: number;
  unterminated: boolean;
  constructor(s: string, pos: number) {
    this.s = s;
    this.pos = pos;
    this.unterminated = false;
  }
  skipWs(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isWs(c)) this.pos++;
      else if (c === 37) { // % comment
        while (this.pos < s.length) {
          const d = s.charCodeAt(this.pos);
          if (d === 10 || d === 13) break;
          this.pos++;
        }
      } else break;
    }
  }
  peekByte(): number {
    return this.pos < this.s.length ? this.s.charCodeAt(this.pos) : -1;
  }
  readRegular(): string {
    const start = this.pos;
    while (this.pos < this.s.length && isRegular(this.s.charCodeAt(this.pos))) this.pos++;
    return this.s.substring(start, this.pos);
  }
  parse(depth: number): PObj | null {
    // Parses one object. Keywords are returned as PKw. Returns null at EOF.
    this.skipWs();
    const s = this.s;
    if (this.pos >= s.length) return null;
    if (depth > 300) throw new Error("nesting too deep");
    const c = s.charCodeAt(this.pos);
    if (c === 47) { // '/' name
      this.pos++;
      let raw = this.readRegular();
      if (raw.indexOf("#") >= 0) {
        let dec = "";
        for (let i = 0; i < raw.length; i++) {
          const h = raw.substring(i + 1, i + 3);
          if (raw.charAt(i) === "#" && /^[0-9A-Fa-f]{2}$/.test(h)) { dec += String.fromCharCode(parseInt(h, 16)); i += 2; }
          else dec += raw.charAt(i);
        }
        raw = dec;
      }
      return mkName(raw);
    }
    if (c === 40) return this.parseLiteralString(); // '('
    if (c === 60) { // '<'
      if (s.charCodeAt(this.pos + 1) === 60) return this.parseDict(depth);
      return this.parseHexString();
    }
    if (c === 91) { // '['
      this.pos++;
      const arr: PObj[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= s.length) break;
        if (s.charCodeAt(this.pos) === 93) { this.pos++; break; }
        const o = this.parse(depth + 1);
        if (o === null) { if (this.pos >= s.length) break; arr.push(null); continue; }
        if (isKw(o)) {
          if (o.v === "R" && arr.length >= 2) {
            const g = arr.pop(), n = arr.pop();
            if (n !== undefined && g !== undefined && isNum(n) && isNum(g)) { arr.push({ t: "ref", n: n, g: g }); continue; }
          }
          if (o.v === "endobj" || o.v === "endstream" || o.v === "stream") { break; }
          continue; // ignore stray keywords inside arrays
        }
        arr.push(o);
      }
      return { t: "arr", v: arr };
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) { // stray delimiters
      this.pos++;
      return this.parse(depth);
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { // number
      const tok = this.readRegular();
      const v = parseFloat(tok);
      return isNaN(v) ? 0 : v;
    }
    const kw = this.readRegular();
    if (kw.length === 0) { this.pos++; return this.parse(depth); }
    if (kw === "true") return true;
    if (kw === "false") return false;
    if (kw === "null") return null as PObj;
    return { t: "kw", v: kw };
  }
  parseDict(depth: number): PDict {
    const s = this.s;
    this.pos += 2;
    const d = mkDict();
    let pendingKey: string | null = null;
    const vals: PObj[] = [];
    // (the key/value bookkeeping stays inline: a local helper could run out of order when the runtime makes it async)
    for (;;) {
      this.skipWs();
      if (this.pos >= s.length) break;
      if (s.charCodeAt(this.pos) === 62) { // '>'
        this.pos++;
        if (s.charCodeAt(this.pos) === 62) this.pos++;
        break;
      }
      const o = this.parse(depth + 1);
      if (o === null) { if (this.pos >= s.length) break; vals.push(null); continue; }
      if (isName(o) && (pendingKey === null || vals.length > 0)) {
        if (pendingKey !== null) d.m.set(pendingKey, vals.length > 0 ? vals[vals.length - 1] : null);
        vals.length = 0;
        pendingKey = o.v;
        continue;
      }
      if (isKw(o)) {
        if (o.v === "R" && vals.length >= 2) {
          const g = vals.pop(), n = vals.pop();
          if (n !== undefined && g !== undefined && isNum(n) && isNum(g)) { vals.push({ t: "ref", n: n, g: g }); continue; }
        }
        if (o.v === "endobj" || o.v === "stream" || o.v === "endstream") {
          // malformed dict without closing >> – rewind so the caller sees the keyword
          this.pos -= o.v.length;
          break;
        }
        continue;
      }
      vals.push(o);
    }
    if (pendingKey !== null) d.m.set(pendingKey, vals.length > 0 ? vals[vals.length - 1] : null);
    return d;
  }
  parseLiteralString(): PStr {
    const s = this.s;
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos++);
      if (c === 92) { // backslash
        const e = s.charCodeAt(this.pos++);
        if (e === 110) out += "\n";
        else if (e === 114) out += "\r";
        else if (e === 116) out += "\t";
        else if (e === 98) out += "\b";
        else if (e === 102) out += "\f";
        else if (e >= 48 && e <= 55) {
          let oct = e - 48;
          for (let k = 0; k < 2; k++) {
            const d = s.charCodeAt(this.pos);
            if (d >= 48 && d <= 55) { oct = oct * 8 + (d - 48); this.pos++; } else break;
          }
          out += String.fromCharCode(oct & 0xff);
        } else if (e === 13) {
          if (s.charCodeAt(this.pos) === 10) this.pos++;
        } else if (e === 10) {
          // line continuation
        } else out += String.fromCharCode(e);
      } else if (c === 40) { depth++; out += "("; }
      else if (c === 41) { depth--; if (depth === 0) break; out += ")"; }
      else out += String.fromCharCode(c);
    }
    if (depth > 0) this.unterminated = true;
    return { t: "str", v: out };
  }
  parseHexString(): PStr {
    const s = this.s;
    this.pos++;
    let out = "";
    let digit = -1;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos++);
      if (c === 62) break;
      let v = -1;
      if (c >= 48 && c <= 57) v = c - 48;
      else if (c >= 65 && c <= 70) v = c - 55;
      else if (c >= 97 && c <= 102) v = c - 87;
      else continue;
      if (digit < 0) digit = v;
      else { out += String.fromCharCode((digit << 4) | v); digit = -1; }
    }
    if (digit >= 0) out += String.fromCharCode(digit << 4);
    return { t: "str", v: out };
  }
}

// ---------------------------------------------------------------------
// Document: object map (brute-force scan, later definitions win),
// object streams, trailer, decryption, stream decoding, page tree
// ---------------------------------------------------------------------
interface ObjEntry { obj: PObj; pos: number; gen: number }

// Standard security handler opened with the empty user password
interface CryptState {
  key: Uint8Array;               // file encryption key
  rev: number;                   // /R
  stmF: string;                  // method for streams: none / rc4 / aesv2 / aesv3
  strF: string;                  // method for strings
  filters: Map<string, string>;  // crypt filter name -> method (streams with a /Crypt filter)
  encryptMetadata: boolean;
  encNum: number;                // object number of the encryption dictionary (-1 = direct)
}

interface PageRef { dict: PDict; resources: PDict | null; box: number[] }

// keys not followed when collecting what the pages use: back links (P, Parent of annotations / fields),
// signature and field values, actions, destinations, metadata, thumbnails
const SIGN_SKIP_KEYS = ["P", "V", "A", "AA", "Dest", "Metadata", "Thumb", "PieceInfo", "B", "SV", "Lock", "Reference", "IRT", "StructParent", "StructParents"];

function samePdfObj(a: PObj, b: PObj, depth: number): boolean {
  // structural equality of two parsed objects (a stream: its dictionary and its raw data)
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (depth > 40 || a.t !== b.t) return false;
  if (a.t === "ref") return isRef(b) && a.n === b.n && a.g === b.g;
  if (a.t === "name" || a.t === "str" || a.t === "kw") return (isName(b) || isStr(b) || isKw(b)) && a.v === b.v;
  if (a.t === "arr") {
    if (!isArr(b) || a.v.length !== b.v.length) return false;
    for (let i = 0; i < a.v.length; i++) if (!samePdfObj(a.v[i], b.v[i], depth + 1)) return false;
    return true;
  }
  const da = a.t === "stream" ? a.d : a.t === "dict" ? a : null;
  const db = isStream(b) ? b.d : isDict(b) ? b : null;
  if (da === null || db === null || da.m.size !== db.m.size) return false;
  if (isStream(a) && (!isStream(b) || a.raw !== b.raw)) return false;
  for (const [k, v] of Array.from(da.m.entries())) {
    const w = db.m.get(k);
    if (w === undefined || !samePdfObj(v, w, depth + 1)) return false;
  }
  return true;
}

const PDF_PASSWORD_PAD = [0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a];

// PdfDoc fields:
//   encrypted: the trailer names an /Encrypt dictionary
//   fileId: first element of the trailer /ID
//   cryptStatus: none / decrypted / password / certificate / unsupported
//   incomplete: reasons why the extracted text may be partial
//   ocOff: optional-content groups that are OFF by default
//   history: earlier definitions of objects that a later one replaced (incremental updates)
//   cryptStatus "protected": an unencrypted wrapper around an encrypted payload (ISO 32000-2, e.g. Microsoft Purview)
class PdfDoc {
  s: string;
  objs: Map<number, ObjEntry>;
  streamCache: Map<number, Uint8Array>;
  failedStreams: Set<number>;
  trailerRoot: PRef | null;
  encrypted: boolean;
  warnings: string[];
  nextStreamId: number;
  encryptObj: PObj | null;
  fileId: string;
  infoObj: PObj | null;
  crypt: CryptState | null;
  cryptStatus: string;
  cryptDetail: string;
  incomplete: string[];
  ocOff: Set<PDict>;
  ocUsed: boolean;
  keyCache: Map<string, Uint8Array>;
  history: Map<number, ObjEntry[]>;

  constructor(s: string) {
    this.s = s;
    this.objs = new Map<number, ObjEntry>();
    this.streamCache = new Map<number, Uint8Array>();
    this.failedStreams = new Set<number>();
    this.trailerRoot = null;
    this.encrypted = false;
    this.warnings = [];
    this.nextStreamId = 1;
    this.encryptObj = null;
    this.fileId = "";
    this.infoObj = null;
    this.crypt = null;
    this.cryptStatus = "none";
    this.cryptDetail = "";
    this.incomplete = [];
    this.ocOff = new Set<PDict>();
    this.ocUsed = false;
    this.keyCache = new Map<string, Uint8Array>();
    this.history = new Map<number, ObjEntry[]>();
  }

  load(): void {
    // two-phase init keeps the constructor free of heavy work (Office Scripts restriction)
    this.scan();
    if (this.encryptObj !== null) this.setupEncryption();
    if (this.cryptStatus === "none" || this.cryptStatus === "decrypted") {
      this.expandObjectStreams();
      this.loadOptionalContent();
      if (this.hasEncryptedPayload()) this.cryptFail("protected", "encrypted payload");
    }
    const tail = Math.max(0, this.s.length - 4096);
    if (this.s.indexOf("%%EOF", tail) < 0) this.flagIncomplete("no %%EOF at the end of the file (truncated?)");
  }

  flagIncomplete(reason: string): void {
    if (this.incomplete.length < 8 && this.incomplete.indexOf(reason) < 0) this.incomplete.push(reason);
  }

  private scan(): void {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(s)) !== null) {
      if (++guard > 500000) { this.flagIncomplete("too many objects"); break; }
      if ((guard & 4095) === 0 && Date.now() > runDeadline) {
        this.warnings.push("time budget exhausted while scanning objects");
        this.flagIncomplete("time budget exhausted");
        break;
      }
      const num = parseInt(m[1], 10);
      const gen = parseInt(m[2], 10);
      const start = m.index;
      let after = start + m[0].length;
      try {
        const lx = new Lexer(s, after);
        let obj = lx.parse(0);
        if (obj !== null && isKw(obj)) obj = null;
        lx.skipWs();
        let end = lx.pos;
        if (isDict(obj) && s.substring(lx.pos, lx.pos + 6) === "stream") {
          const r = this.readStream(obj, lx.pos + 6, num, gen);
          obj = r.stream;
          end = r.end;
        }
        const prevDef = this.objs.get(num);
        if (prevDef !== undefined) this.remember(num, prevDef);
        this.objs.set(num, { obj: obj, pos: start, gen: gen });
        // an unbalanced "(" must not swallow the rest of the file: rescan right after the header, or
        // after the first "endobj" when the parse ran past it (a later ")" closed the broken string)
        const ej = isStream(obj) ? -1 : s.indexOf("endobj", after);
        if (lx.unterminated) { /* keep after */ }
        else if (ej >= 0 && ej + 6 < end) { after = ej + 6; this.flagIncomplete("object " + num + " is malformed"); }
        else after = Math.max(after, end);
      } catch (e) {
        this.warnings.push("object " + num + ": " + String(e));
      }
      re.lastIndex = after;
    }
    // trailer dictionaries (classic trailers and cross-reference streams), newest last
    const trailers: { d: PDict; pos: number }[] = [];
    const tre = /trailer\s*<</g;
    let tm: RegExpExecArray | null;
    while ((tm = tre.exec(s)) !== null) {
      try {
        const lx = new Lexer(s, tm.index + 7);
        const d = lx.parse(0);
        if (isDict(d)) trailers.push({ d: d, pos: tm.index });
      } catch (e) { /* ignore */ }
    }
    for (const e of Array.from(this.objs.values())) {
      if (isStream(e.obj)) {
        const ty = e.obj.d.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "XRef") trailers.push({ d: e.obj.d, pos: e.pos });
      }
    }
    trailers.sort((a, b) => a.pos - b.pos);
    for (const t of trailers) {
      const root = t.d.m.get("Root");
      if (root !== undefined && isRef(root)) this.trailerRoot = root;
      const enc = t.d.m.get("Encrypt");
      if (enc !== undefined && enc !== null) { this.encrypted = true; this.encryptObj = enc; }
      const info = t.d.m.get("Info");
      if (info !== undefined && info !== null) this.infoObj = info;
      const id = t.d.m.get("ID");
      if (id !== undefined && isArr(id) && id.v.length > 0 && isStr(id.v[0])) this.fileId = (id.v[0] as PStr).v;
    }
  }

  private readStream(d: PDict, p: number, num: number, gen: number): { stream: PStream; end: number } {
    const s = this.s;
    // after the 'stream' keyword: CRLF or LF
    if (s.charCodeAt(p) === 13) p++;
    if (s.charCodeAt(p) === 10) p++;
    const dataStart = p;
    let len = -1;
    const L = d.m.get("Length");
    if (L !== undefined && isNum(L)) len = L;
    // (an indirect /Length is resolved later in streamData)
    let dataEnd = -1;
    if (len >= 0 && dataStart + len <= s.length) {
      const probe = new Lexer(s, dataStart + len);
      probe.skipWs();
      if (s.substring(probe.pos, probe.pos + 9) === "endstream") dataEnd = dataStart + len;
    }
    const exact = dataEnd >= 0;
    if (dataEnd < 0) {
      // fall back to searching the keyword
      let idx = s.indexOf("endstream", dataStart);
      if (idx < 0) {
        idx = s.length;
        this.flagIncomplete("stream " + num + " has no endstream (file truncated?)");
      }
      dataEnd = idx;
      // strip trailing EOL
      if (s.charCodeAt(dataEnd - 1) === 10) dataEnd--;
      if (s.charCodeAt(dataEnd - 1) === 13) dataEnd--;
    }
    const raw = s.substring(dataStart, dataEnd);
    let end = s.indexOf("endstream", dataEnd);
    end = end < 0 ? s.length : end + 9;
    const ej = s.indexOf("endobj", end);
    if (ej >= 0 && ej - end < 4) end = ej + 6;
    return { stream: { t: "stream", d: d, raw: raw, id: this.nextStreamId++, n: num, g: gen, start: dataStart, exactLen: exact }, end: end };
  }

  private setupEncryption(): void {
    // Standard security handler (ISO 32000-2 7.6.4) opened with the empty user password
    const enc = this.dictOf(this.encryptObj === null ? undefined : this.encryptObj);
    if (!enc) { this.cryptFail("unsupported", "encryption dictionary not found"); return; }
    const filter = this.nameOf(enc.m.get("Filter"));
    if (filter.indexOf("PubSec") >= 0) { this.cryptFail("certificate", filter); return; }
    if (filter !== "Standard") { this.cryptFail("unsupported", "security handler " + (filter || "?")); return; }
    const v = this.num(enc.m.get("V"), 0);
    const r = this.num(enc.m.get("R"), 0);
    if (v !== 1 && v !== 2 && v !== 4 && v !== 5) { this.cryptFail("unsupported", "/V " + v); return; }
    const o = this.strBytes(enc.m.get("O"));
    const u = this.strBytes(enc.m.get("U"));
    const p = this.num(enc.m.get("P"), 0) | 0;
    const encryptMetadata = this.resolve(enc.m.get("EncryptMetadata")) !== false;
    const methods = new Map<string, string>();
    methods.set("Identity", "none");
    let cfLen = 0;
    const cf = this.dictOf(enc.m.get("CF"));
    if (cf) {
      for (const [name, val] of Array.from(cf.m.entries())) {
        const cd = this.dictOf(val);
        const cfm = cd ? this.nameOf(cd.m.get("CFM")) : "";
        methods.set(name, cfm === "V2" ? "rc4" : cfm === "AESV2" ? "aesv2" : cfm === "AESV3" ? "aesv3" : cfm === "None" || cfm === "" ? "none" : "?" + cfm);
        if (cd && cfLen === 0) cfLen = this.num(cd.m.get("Length"), 0);
      }
    }
    let stmF = "rc4", strF = "rc4";
    if (v >= 4) {
      const sn = this.nameOf(enc.m.get("StmF")) || "Identity", tn = this.nameOf(enc.m.get("StrF")) || "Identity";
      stmF = methods.get(sn) || "?" + sn;
      strF = methods.get(tn) || "?" + tn;
    }
    if (stmF.charAt(0) === "?" || strF.charAt(0) === "?") { this.cryptFail("unsupported", "crypt filter " + (stmF.charAt(0) === "?" ? stmF : strF).substring(1)); return; }
    // key length in bits (generators sometimes give bytes)
    let lenBits = this.num(enc.m.get("Length"), 0);
    if (lenBits <= 0) lenBits = v <= 2 ? 40 : cfLen > 0 ? cfLen : 128;
    if (lenBits < 40) lenBits *= 8;
    if (lenBits % 8 !== 0 || lenBits > 256) lenBits = 128;
    const empty = new Uint8Array(0);
    let key: Uint8Array;
    if (r >= 2 && r <= 4) {
      const n = r === 2 ? 5 : Math.max(5, Math.min(16, lenBits >> 3));
      const id = latin1ToBytes(this.fileId);
      const pad = new Uint8Array(PDF_PASSWORD_PAD);
      const parts = [pad, o.subarray(0, 32), new Uint8Array([p & 255, (p >>> 8) & 255, (p >>> 16) & 255, (p >>> 24) & 255]), id];
      if (r >= 4 && !encryptMetadata) parts.push(new Uint8Array([255, 255, 255, 255]));
      let h = md5(concatBytes(parts));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      key = h.subarray(0, n);
      // the empty password is the user password only if it reproduces /U (algorithms 4 and 5)
      let ok = false;
      if (r === 2) ok = bytesEqual(rc4(key, pad), u, 32);
      else {
        let x = rc4(key, md5(concatBytes([pad, id])));
        const k2 = new Uint8Array(n);
        for (let i = 1; i <= 19; i++) {
          for (let j = 0; j < n; j++) k2[j] = key[j] ^ i;
          x = rc4(k2, x);
        }
        ok = bytesEqual(x, u, 16);
      }
      if (!ok) { this.cryptFail("password", ""); return; }
    } else if (r === 5 || r === 6) {
      const ue = this.strBytes(enc.m.get("UE"));
      if (u.length < 48 || ue.length < 32) { this.cryptFail("unsupported", "/U or /UE too short"); return; }
      const check = pdfPasswordHash(empty, u.subarray(32, 40), empty, r === 6);
      if (!bytesEqual(check, u, 32)) { this.cryptFail("password", ""); return; }
      const ik = pdfPasswordHash(empty, u.subarray(40, 48), empty, r === 6);
      key = aesCbc(ik, new Uint8Array(16), ue.subarray(0, 32), 0, true);
      const perms = this.strBytes(enc.m.get("Perms"));
      if (perms.length >= 16) {
        const dp = aesCbc(key, new Uint8Array(16), perms.subarray(0, 16), 0, true);
        if (dp[9] !== 0x61 || dp[10] !== 0x64 || dp[11] !== 0x62) this.warnings.push("encryption: /Perms check failed");
      }
    } else {
      this.cryptFail("unsupported", "/R " + r);
      return;
    }
    this.crypt = {
      key: key,
      rev: r,
      stmF: stmF,
      strF: strF,
      filters: methods,
      encryptMetadata: encryptMetadata,
      encNum: isRef(this.encryptObj) ? this.encryptObj.n : -1,
    };
    this.cryptStatus = "decrypted";
    this.cryptDetail = "R" + r + " " + stmF;
    this.decryptAllStrings();
  }

  private cryptFail(status: string, detail: string): void {
    this.cryptStatus = status;
    this.cryptDetail = detail;
  }

  private strBytes(o: PObj | undefined): Uint8Array {
    const r = this.resolve(o);
    return isStr(r) ? latin1ToBytes(r.v) : new Uint8Array(0);
  }

  private objectKey(num: number, gen: number, method: string): Uint8Array {
    // per-object key (algorithm 1); AES-256 uses the file key directly
    const c = this.crypt as CryptState;
    if (method === "aesv3" || c.rev >= 5) return c.key;
    const ck = num + "/" + gen + "/" + method;
    const hit = this.keyCache.get(ck);
    if (hit !== undefined) return hit;
    const parts = [c.key, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])];
    if (method === "aesv2") parts.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
    const k = md5(concatBytes(parts)).subarray(0, Math.min(c.key.length + 5, 16));
    this.keyCache.set(ck, k);
    return k;
  }

  private decryptBytes(data: Uint8Array, num: number, gen: number, method: string): Uint8Array {
    if (method === "none" || !this.crypt) return data;
    const key = this.objectKey(num, gen, method);
    if (method === "rc4") return rc4(key, data);
    // AES-CBC: 16-byte IV in front, PKCS#5 padding at the end
    if (data.length < 32) return new Uint8Array(0);
    const out = aesCbc(key, data.subarray(0, 16), data, 16, true);
    const padN = out.length > 0 ? out[out.length - 1] : 0;
    return padN >= 1 && padN <= 16 && padN <= out.length ? out.subarray(0, out.length - padN) : out;
  }

  private decryptAllStrings(): void {
    // strings of top-level objects (not inside object streams, not the encryption dictionary)
    const c = this.crypt;
    if (!c || c.strF === "none") return;
    let count = 0;
    for (const [num, e] of Array.from(this.objs.entries())) {
      if ((++count & 1023) === 0 && Date.now() > runDeadline) { this.flagIncomplete("time budget exhausted"); break; }
      if (num === c.encNum) continue;
      let top: PObj = e.obj;
      if (isStream(top)) {
        const ty = top.d.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "XRef") continue;
        top = top.d;
      }
      if (isDict(top)) {
        const ty = top.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "Sig") continue;
      }
      const stack: PObj[] = [top];
      let guard = 0;
      while (stack.length > 0 && ++guard < 200000) {
        const o = stack.pop();
        if (o === undefined || o === null || typeof o !== "object") continue;
        if (o.t === "str") {
          const b = this.decryptBytes(latin1ToBytes(o.v), num, e.gen, c.strF);
          o.v = bytesToLatin1(b, 0, b.length);
        } else if (o.t === "arr") {
          for (const x of o.v) stack.push(x);
        } else if (o.t === "dict") {
          for (const x of Array.from(o.m.values())) stack.push(x);
        }
      }
    }
  }

  private expandObjectStreams(): void {
    const stms: { entry: ObjEntry; num: number }[] = [];
    for (const [num, e] of Array.from(this.objs.entries())) {
      if (isStream(e.obj)) {
        const ty = e.obj.d.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "ObjStm") stms.push({ entry: e, num: num });
      }
    }
    stms.sort((a, b) => a.entry.pos - b.entry.pos);
    for (const st of stms) {
      try {
        const stream = st.entry.obj as PStream;
        const data = this.streamData(stream);
        const text = bytesToLatin1(data, 0, data.length);
        const n = this.num(stream.d.m.get("N"), 0);
        const first = this.num(stream.d.m.get("First"), 0);
        const hdr = new Lexer(text, 0);
        const pairs: number[] = [];
        for (let i = 0; i < n * 2; i++) {
          const v = hdr.parse(0);
          if (!isNum(v)) break;
          pairs.push(v);
        }
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const onum = pairs[i], off = pairs[i + 1];
          const lx = new Lexer(text, first + off);
          const obj = lx.parse(0);
          const existing = this.objs.get(onum);
          const def: ObjEntry = { obj: obj === null || isKw(obj) ? null : obj, pos: st.entry.pos, gen: 0 };
          // position rule: the definition that appears later in the file wins
          if (existing === undefined || existing.pos < st.entry.pos) {
            if (existing !== undefined) this.remember(onum, existing);
            this.objs.set(onum, def);
          } else this.remember(onum, def);
        }
      } catch (e) {
        this.warnings.push("ObjStm " + st.num + ": " + String(e));
      }
    }
  }

  private remember(num: number, e: ObjEntry): void {
    // keeps a replaced definition (needed to tell whether an update after signing changed an object)
    const h = this.history.get(num);
    if (h === undefined) this.history.set(num, [e]);
    else if (h.length < 64) h.push(e);
  }

  private hasEncryptedPayload(): boolean {
    // ISO 32000-2 unencrypted wrapper document: the real (encrypted) PDF is an embedded file with
    // /AFRelationship /EncryptedPayload; the visible page is only a cover sheet
    for (const e of Array.from(this.objs.values())) {
      const d = isDict(e.obj) ? e.obj : isStream(e.obj) ? e.obj.d : null;
      if (d === null) continue;
      const af = d.m.get("AFRelationship"), ty = d.m.get("Type"), ep = d.m.get("EP");
      if (af !== undefined && isName(af) && af.v === "EncryptedPayload") return true;
      if (ty !== undefined && isName(ty) && ty.v === "EncryptedPayload") return true;
      if (ep !== undefined && isDict(ep)) {
        const et = ep.m.get("Type");
        if (et !== undefined && isName(et) && et.v === "EncryptedPayload") return true;
      }
    }
    return false;
  }

  changedAfterSigning(): string {
    // A signed PDF with an incremental update after its last signature: names the first object used by the
    // pages (page tree, content streams, resources, annotations and their appearances) that this update added
    // or changed, "" when there is none. Updates that only add LTV data (DSS) or touch the catalog pass.
    const s = this.s;
    let sigEnd = -1;
    let p = s.indexOf("/ByteRange");
    for (let k = 0; p >= 0 && k < 500; k++) {
      let arr: PObj | null = null;
      try { arr = new Lexer(s, p + 10).parse(0); } catch (e) { arr = null; }
      if (arr !== null && isArr(arr) && arr.v.length === 4) {
        const a = arr.v[0], b = arr.v[1], c = arr.v[2], d = arr.v[3];
        // a real signature: [0 b c d] around the /Contents hex string, inside the file
        if (isNum(a) && isNum(b) && isNum(c) && isNum(d) && a === 0 && b > 0 && c > b && d >= 0 && c + d <= s.length &&
          s.charCodeAt(b) === 60 && s.charCodeAt(c - 1) === 62 && c + d > sigEnd) sigEnd = c + d;
      }
      p = s.indexOf("/ByteRange", p + 10);
    }
    if (sigEnd < 0) return "";
    let q = sigEnd;
    while (q < s.length && q < sigEnd + 256 && s.charCodeAt(q) <= 32) q++;
    if (q >= s.length) return "";
    const cat = this.catalog();
    const pagesRef = cat ? cat.m.get("Pages") : undefined;
    if (pagesRef === undefined) return "";
    const stack: PObj[] = [pagesRef];
    const seen = new Set<number>();
    for (let guard = 0; stack.length > 0 && guard < 200000; guard++) {
      const o = stack.pop();
      if (o === undefined || o === null || typeof o !== "object") continue;
      if (o.t === "ref") {
        if (seen.has(o.n) || seen.size > 20000) continue;
        seen.add(o.n);
        const e = this.objs.get(o.n);
        if (e === undefined) continue;
        if (e.pos >= sigEnd) {
          let old: ObjEntry | null = null;
          const hist = this.history.get(o.n);
          if (hist !== undefined) for (const h of hist) if (h.pos < sigEnd && (old === null || h.pos > old.pos)) old = h;
          if (old === null || !samePdfObj(old.obj, e.obj, 0)) return "object " + o.n + (old === null ? " added" : " changed");
        }
        stack.push(e.obj);
        continue;
      }
      if (o.t === "arr") { for (const x of o.v) stack.push(x); continue; }
      const d = o.t === "dict" ? o : o.t === "stream" ? o.d : null;
      if (d === null || d.m.has("ByteRange")) continue; // a signature value is covered by its own signature
      const ty = d.m.get("Type");
      const node = ty !== undefined && isName(ty) && (ty.v === "Page" || ty.v === "Pages");
      for (const [key, val] of Array.from(d.m.entries())) {
        if (key === "Parent" ? !node : SIGN_SKIP_KEYS.indexOf(key) >= 0) continue;
        stack.push(val);
      }
    }
    return "";
  }

  private loadOptionalContent(): void {
    // optional-content groups that are OFF in the default configuration (/OCProperties /D)
    const cat = this.catalog();
    const ocp = cat ? this.dictOf(cat.m.get("OCProperties")) : null;
    if (!ocp) return;
    this.ocUsed = true;
    const d = this.dictOf(ocp.m.get("D"));
    if (!d) return;
    if (this.nameOf(d.m.get("BaseState")) === "OFF") {
      for (const g of this.arrOf(ocp.m.get("OCGs"))) { const gd = this.dictOf(g); if (gd) this.ocOff.add(gd); }
      for (const g of this.arrOf(d.m.get("ON"))) { const gd = this.dictOf(g); if (gd) this.ocOff.delete(gd); }
    }
    for (const g of this.arrOf(d.m.get("OFF"))) { const gd = this.dictOf(g); if (gd) this.ocOff.add(gd); }
  }

  isHiddenOC(o: PObj | undefined): boolean {
    // true when an optional-content group or membership dictionary is OFF by default
    if (!this.ocUsed || o === undefined) return false;
    const d = this.dictOf(o);
    if (!d) return false;
    if (this.nameOf(d.m.get("Type")) !== "OCMD") return this.ocOff.has(d);
    const raw = this.resolve(d.m.get("OCGs"));
    const groups: PDict[] = [];
    if (isDict(raw)) groups.push(raw);
    else if (isArr(raw)) for (const g of raw.v) { const gd = this.dictOf(g); if (gd) groups.push(gd); }
    if (groups.length === 0) return false;
    let on = 0;
    for (const g of groups) if (!this.ocOff.has(g)) on++;
    const policy = this.nameOf(d.m.get("P"));
    if (policy === "AllOn") return on < groups.length;
    if (policy === "AnyOff") return on === groups.length;
    if (policy === "AllOff") return on > 0;
    return on === 0; // AnyOn (default)
  }

  producerInfo(): string {
    // /Producer and /Creator of the document information dictionary (NULs of UTF-16 removed)
    const info = this.dictOf(this.infoObj === null ? undefined : this.infoObj);
    if (!info) return "";
    let out = "";
    const keys = ["Producer", "Creator"];
    for (const k of keys) {
      const v = this.resolve(info.m.get(k));
      if (isStr(v)) out += " " + v.v.replace(/\u0000/g, "");
    }
    return out;
  }

  resolve(o: PObj | undefined): PObj {
    // object access
    let cur: PObj = o === undefined ? null : o;
    for (let i = 0; i < 32 && isRef(cur); i++) {
      const e = this.objs.get(cur.n);
      cur = e === undefined ? null : e.obj;
    }
    return isRef(cur) ? null : cur;
  }
  get(d: PDict | null, key: string): PObj {
    if (!d) return null;
    return this.resolve(d.m.get(key));
  }
  num(o: PObj | undefined, def: number): number {
    const r = this.resolve(o);
    return isNum(r) ? r : def;
  }
  nameOf(o: PObj | undefined): string {
    const r = this.resolve(o);
    return isName(r) ? r.v : "";
  }
  dictOf(o: PObj | undefined): PDict | null {
    const r = this.resolve(o);
    if (isDict(r)) return r;
    if (isStream(r)) return r.d;
    return null;
  }
  arrOf(o: PObj | undefined): PObj[] {
    const r = this.resolve(o);
    return isArr(r) ? r.v : [];
  }
  numArr(o: PObj | undefined, def: number): number[] {
    // numbers of an array object (plain loop, no Array callback)
    const out: number[] = [];
    for (const v of this.arrOf(o)) out.push(this.num(v, def));
    return out;
  }

  streamData(st: PStream): Uint8Array {
    // stream decoding
    const cached = this.streamCache.get(st.id);
    if (cached !== undefined) return cached;
    if (this.failedStreams.has(st.id)) throw new Error("stream could not be decoded (see its first warning)");
    if (Date.now() > runDeadline) {
      this.flagIncomplete("time budget exhausted");
      throw new Error("time budget exhausted");
    }
    this.failedStreams.add(st.id); // removed again below on success: a broken or oversized stream is decoded only once
    let data = latin1ToBytes(st.exactLen ? st.raw : this.refineRaw(st));
    const filters: string[] = [];
    const f = this.resolve(st.d.m.get("Filter"));
    if (isName(f)) filters.push(f.v);
    else if (isArr(f)) for (const x of f.v) { const n = this.resolve(x); if (isName(n)) filters.push(n.v); }
    const parmsObj = this.resolve(st.d.m.get("DecodeParms"));
    const parms: (PDict | null)[] = [];
    if (isDict(parmsObj)) parms.push(parmsObj);
    else if (isArr(parmsObj)) for (const x of parmsObj.v) { const d = this.resolve(x); parms.push(isDict(d) ? d : null); }
    if (this.crypt) {
      let method = this.crypt.stmF;
      const ty = this.nameOf(st.d.m.get("Type"));
      if (filters.length > 0 && filters[0] === "Crypt") {
        const cp = parms.length > 0 ? parms[0] : null;
        const cn = cp ? this.nameOf(cp.m.get("Name")) : "";
        const cm = this.crypt.filters.get(cn || "Identity");
        method = cm === undefined || cm.charAt(0) === "?" ? "none" : cm;
      } else if (ty === "XRef" || (ty === "Metadata" && !this.crypt.encryptMetadata)) {
        method = "none";
      }
      if (method !== "none") data = this.decryptBytes(data, st.n, st.g, method);
    }
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i];
      const pd = parms.length === 1 && filters.length === 1 ? parms[0] : (parms[i] || null);
      if (name === "FlateDecode" || name === "Fl") {
        const r = inflate(data);
        if (!r.complete) this.flagIncomplete("compressed stream " + st.n + " is truncated or corrupt");
        data = this.predict(r.data, pd);
      } else if (name === "LZWDecode" || name === "LZW") {
        const r = lzwDecode(data, this.num(pd ? pd.m.get("EarlyChange") : undefined, 1));
        if (!r.complete) this.flagIncomplete("LZW stream " + st.n + " is truncated or corrupt");
        data = this.predict(r.data, pd);
      } else if (name === "ASCIIHexDecode" || name === "AHx") {
        data = asciiHexDecode(data);
      } else if (name === "ASCII85Decode" || name === "A85") {
        data = ascii85Decode(data);
      } else if (name === "RunLengthDecode" || name === "RL") {
        data = runLengthDecode(data);
      } else if (name === "Crypt") {
        // crypt filter: already applied above
      } else {
        // image / unsupported filters: leave as is
        break;
      }
    }
    this.failedStreams.delete(st.id);
    this.streamCache.set(st.id, data);
    return data;
  }
  private refineRaw(st: PStream): string {
    // stream cut at "endstream": an indirect /Length that ends right before "endstream" is exact
    const len = this.num(st.d.m.get("Length"), -1);
    const s = this.s;
    if (len >= 0 && st.start + len <= s.length) {
      const probe = new Lexer(s, st.start + len);
      probe.skipWs();
      if (s.substring(probe.pos, probe.pos + 9) === "endstream") return s.substring(st.start, st.start + len);
    }
    return st.raw;
  }
  private predict(data: Uint8Array, pd: PDict | null): Uint8Array {
    if (!pd) return data;
    const pred = this.num(pd.m.get("Predictor"), 1);
    if (pred <= 1) return data;
    return applyPredictor(data, pred, this.num(pd.m.get("Colors"), 1), this.num(pd.m.get("BitsPerComponent"), 8), this.num(pd.m.get("Columns"), 1));
  }
  streamText(st: PStream): string {
    const d = this.streamData(st);
    return bytesToLatin1(d, 0, d.length);
  }

  catalog(): PDict | null {
    let root: PDict | null = this.trailerRoot ? this.dictOf(this.trailerRoot) : null;
    if (!root) root = this.findCatalog();
    return root;
  }

  pages(): PageRef[] {
    // page tree
    const out: PageRef[] = [];
    const seen = new Set<PDict>();
    const root = this.catalog();
    const pagesRoot = root ? this.dictOf(root.m.get("Pages")) : null;
    if (pagesRoot) this.walkPages(pagesRoot, null, 0, out, seen);
    if (out.length === 0) {
      // fallback: every /Type /Page object in file order
      const found: { d: PDict; pos: number }[] = [];
      for (const e of Array.from(this.objs.values())) {
        if (isDict(e.obj) && this.nameOf(e.obj.m.get("Type")) === "Page") found.push({ d: e.obj, pos: e.pos });
      }
      found.sort((a, b) => a.pos - b.pos);
      for (const f of found) {
        let res = this.dictOf(f.d.m.get("Resources"));
        let parent = this.dictOf(f.d.m.get("Parent"));
        for (let i = 0; !res && parent && i < 32; i++) {
          res = this.dictOf(parent.m.get("Resources"));
          parent = this.dictOf(parent.m.get("Parent"));
        }
        out.push({ dict: f.d, resources: res, box: this.pageBox(f.d) });
      }
    }
    return out;
  }

  private walkPages(node: PDict, inherited: PDict | null, depth: number, out: PageRef[], seen: Set<PDict>): void {
    if (depth > 64 || seen.has(node)) return;
    seen.add(node);
    const res = this.dictOf(node.m.get("Resources")) || inherited;
    const type = this.nameOf(node.m.get("Type"));
    const kids = this.arrOf(node.m.get("Kids"));
    if (type === "Page" || (kids.length === 0 && node.m.has("Contents"))) {
      out.push({ dict: node, resources: res, box: this.pageBox(node) });
      return;
    }
    for (const k of kids) {
      const kd = this.dictOf(k);
      if (kd) this.walkPages(kd, res, depth + 1, out, seen);
      else if (isRef(k)) this.flagIncomplete("page object " + k.n + " missing");
    }
  }

  private pageBox(page: PDict): number[] {
    // visible area: CropBox, else MediaBox (both inheritable), as [x0, y0, x1, y1]
    let node: PDict | null = page;
    let media: number[] = [], crop: number[] = [];
    for (let i = 0; node && i < 32; i++) {
      if (crop.length !== 4) crop = this.numArr(node.m.get("CropBox"), 0);
      if (media.length !== 4) media = this.numArr(node.m.get("MediaBox"), 0);
      node = this.dictOf(node.m.get("Parent"));
    }
    const b = crop.length === 4 ? crop : media.length === 4 ? media : [0, 0, 612, 792];
    return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  }

  private findCatalog(): PDict | null {
    let found: PDict | null = null;
    for (const e of Array.from(this.objs.values())) {
      if (found === null && isDict(e.obj) && this.nameOf(e.obj.m.get("Type")) === "Catalog") found = e.obj;
    }
    return found;
  }

  pageContent(page: PDict): string {
    const raw = page.m.get("Contents");
    const c = this.resolve(raw);
    if (isStream(c)) return this.streamText(c);
    if (isArr(c)) {
      let s = "";
      for (const x of c.v) {
        const st = this.resolve(x);
        if (isStream(st)) s += this.streamText(st) + "\n";
        else if (isRef(x)) this.flagIncomplete("content stream " + x.n + " missing");
      }
      return s;
    }
    if (raw !== undefined && isRef(raw)) this.flagIncomplete("content stream " + raw.n + " missing");
    return "";
  }
}

// ---------------------------------------------------------------------
// CMaps (ToUnicode + embedded encoding CMaps)
// ---------------------------------------------------------------------
interface CodeRange { nBytes: number; lo: number; hi: number }

interface CMapData {
  ranges: CodeRange[];
  single: Map<number, string>;             // code -> unicode (ToUnicode) or CID as string (encoding cmap)
  rangeList: { lo: number; hi: number; dst: number; nBytes: number }[]; // code ranges -> starting cid / code point
  vertical: boolean;
}

function hexStrToInt(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length && i < 4; i++) v = (v << 8) | (s.charCodeAt(i) & 0xff);
  return v >>> 0;
}

function utf16beToString(s: string): string {
  if (s.length === 1) return s; // single byte destination
  let out = "";
  for (let i = 0; i + 1 < s.length; i += 2) {
    const cu = ((s.charCodeAt(i) & 0xff) << 8) | (s.charCodeAt(i + 1) & 0xff);
    out += String.fromCharCode(cu);
  }
  if (s.length % 2 === 1) out += String.fromCharCode(s.charCodeAt(s.length - 1) & 0xff);
  return out;
}

function stringIncrement(s: string, by: number): string {
  // increment the last UTF-16 code unit (sufficient for bfrange destinations)
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1) + by;
  return s.substring(0, s.length - 1) + String.fromCharCode(last & 0xffff);
}

function parseCMap(text: string, mode: "uni" | "cid"): CMapData {
  // mode "uni": destinations are UTF-16BE strings; mode "cid": destinations are integers
  const cm: CMapData = { ranges: [], single: new Map<number, string>(), rangeList: [], vertical: false };
  const lx = new Lexer(text, 0);
  const stack: PObj[] = [];
  let guard = 0;
  for (;;) {
    if (++guard > 2000000) break;
    let o: PObj | null;
    try { o = lx.parse(0); } catch (e) { break; }
    if (o === null) { if (lx.pos >= text.length) break; continue; }
    if (!isKw(o)) { stack.push(o); if (stack.length > 64) stack.shift(); continue; }
    const kw = o.v;
    if (kw === "begincodespacerange") {
      for (;;) {
        const a = lx.parse(0); if (a === null || isKw(a)) break;
        const b = lx.parse(0); if (b === null || isKw(b)) break;
        if (isStr(a) && isStr(b)) cm.ranges.push({ nBytes: Math.max(1, Math.min(4, a.v.length)), lo: hexStrToInt(a.v), hi: hexStrToInt(b.v) });
      }
    } else if (kw === "beginbfchar" || kw === "begincidchar") {
      for (;;) {
        const a = lx.parse(0); if (a === null || isKw(a)) break;
        const b = lx.parse(0); if (b === null || isKw(b)) break;
        if (!isStr(a)) continue;
        const code = hexStrToInt(a.v);
        if (mode === "uni") {
          if (isStr(b)) cm.single.set(code, utf16beToString(b.v));
          else if (isName(b)) { const u = glyphNameToUnicode(b.v); if (u) cm.single.set(code, u); }
        } else if (isNum(b)) cm.single.set(code, String(b));
      }
    } else if (kw === "beginbfrange" || kw === "begincidrange") {
      for (;;) {
        const a = lx.parse(0); if (a === null || isKw(a)) break;
        const b = lx.parse(0); if (b === null || isKw(b)) break;
        const c = lx.parse(0); if (c === null || isKw(c)) break;
        if (!isStr(a) || !isStr(b)) continue;
        const lo = hexStrToInt(a.v), hi = hexStrToInt(b.v);
        if (hi < lo || hi - lo > 65535) continue;
        if (mode === "uni") {
          if (isStr(c)) {
            const dst = utf16beToString(c.v);
            if (dst.length === 1) cm.rangeList.push({ lo: lo, hi: hi, dst: dst.charCodeAt(0), nBytes: a.v.length });
            else for (let k = 0; k <= hi - lo; k++) cm.single.set(lo + k, stringIncrement(dst, k));
          } else if (isArr(c)) {
            for (let k = 0; k < c.v.length && lo + k <= hi; k++) {
              const d = c.v[k];
              if (isStr(d)) cm.single.set(lo + k, utf16beToString(d.v));
            }
          }
        } else if (isNum(c)) {
          cm.rangeList.push({ lo: lo, hi: hi, dst: c, nBytes: a.v.length });
        }
      }
    } else if (kw === "endcmap") {
      // keep going; some files concatenate
    } else if (kw === "def") {
      // /WMode 1 def
      if (stack.length >= 2 && isName(stack[stack.length - 2]) && (stack[stack.length - 2] as PName).v === "WMode" && stack[stack.length - 1] === 1) cm.vertical = true;
    }
  }
  return cm;
}

function cmapLookup(cm: CMapData, code: number): string | null {
  const s = cm.single.get(code);
  if (s !== undefined) return s;
  for (let i = cm.rangeList.length - 1; i >= 0; i--) {
    const r = cm.rangeList[i];
    if (code >= r.lo && code <= r.hi) return String.fromCharCode(r.dst + (code - r.lo));
  }
  return null;
}
function cmapLookupCid(cm: CMapData, code: number): number {
  const s = cm.single.get(code);
  if (s !== undefined) return parseInt(s, 10);
  for (let i = cm.rangeList.length - 1; i >= 0; i--) {
    const r = cm.rangeList[i];
    if (code >= r.lo && code <= r.hi) return r.dst + (code - r.lo);
  }
  return code;
}

function glyphNameToUnicode(name: string): string {
  // Glyph names -> Unicode
  if (name.length === 0) return "";
  const direct = GLYPHS[name];
  if (direct !== undefined) return String.fromCharCode(direct);
  const dot = name.indexOf(".");
  if (dot > 0) return glyphNameToUnicode(name.substring(0, dot));
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp <= 0xffff) return String.fromCharCode(cp);
    const v = cp - 0x10000;
    return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
  }
  m = /^(?:g|cid|c|G|index)(\d+)$/.exec(name);
  if (m) return ""; // glyph index names carry no Unicode
  if (name.length === 1) return name;
  // names like "Cxx" / "Gxx" / "ccxx" are unknown
  return "";
}

// ---------------------------------------------------------------------
// TrueType 'cmap' parsing (for fonts without ToUnicode)
// ---------------------------------------------------------------------
interface TtMaps { gidToUni: Map<number, number>; codeToGid: Map<number, number>; hasUni: boolean }

function parseTrueTypeCmap(data: Uint8Array): TtMaps | null {
  const u16 = (p: number): number => (data[p] << 8) | data[p + 1];
  const u32 = (p: number): number => ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
  if (data.length < 12) return null;
  let base = 0;
  const tag = u32(0);
  if (tag === 0x74746366) base = u32(12); // 'ttcf' collection: first font
  const numTables = u16(base + 4);
  if (numTables > 512) return null;
  let cmapOff = -1, cmapLen = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > data.length) break;
    const t = bytesToLatin1(data, rec, rec + 4);
    if (t === "cmap") { cmapOff = u32(rec + 8); cmapLen = u32(rec + 12); }
  }
  if (cmapOff < 0 || cmapOff + 4 > data.length || cmapLen < 4) return null;
  const maps: TtMaps = { gidToUni: new Map<number, number>(), codeToGid: new Map<number, number>(), hasUni: false };
  const n = u16(cmapOff + 2);
  // (code, glyph) pairs of one subtable, stored in the loop body below (no local helper: keeps the
  // "first code point wins" order intact when the runtime makes helpers async)
  const pc: number[] = [], pg: number[] = [];
  for (let i = 0; i < n && i < 32; i++) {
    const rec = cmapOff + 4 + i * 8;
    if (rec + 8 > data.length) break;
    const pid = u16(rec), eid = u16(rec + 2), off = u32(rec + 4);
    const sub = cmapOff + off;
    if (sub + 4 > data.length) continue;
    const isUni = (pid === 3 && (eid === 1 || eid === 10)) || pid === 0;
    const isSym = pid === 3 && eid === 0;
    const isMac = pid === 1 && eid === 0;
    if (!isUni && !isSym && !isMac) continue;
    const format = u16(sub);
    pc.length = 0;
    pg.length = 0;
    if (format === 0) {
      for (let c = 0; c < 256; c++) { pc.push(c); pg.push(data[sub + 6 + c]); }
    } else if (format === 4) {
      const segX2 = u16(sub + 6);
      const endP = sub + 14, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(endP + s * 2), start = u16(startP + s * 2), delta = u16(deltaP + s * 2), ro = u16(rangeP + s * 2);
        if (start > end) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid: number;
          if (ro === 0) gid = (c + delta) & 0xffff;
          else {
            const gp = rangeP + s * 2 + ro + (c - start) * 2;
            if (gp + 2 > data.length) continue;
            gid = u16(gp);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          pc.push(c);
          pg.push(gid);
        }
      }
    } else if (format === 6) {
      const first = u16(sub + 6), cnt = u16(sub + 8);
      for (let k = 0; k < cnt; k++) { pc.push(first + k); pg.push(u16(sub + 10 + k * 2)); }
    } else if (format === 12) {
      const nGroups = u32(sub + 12);
      for (let g = 0; g < nGroups && g < 100000 && pc.length < 300000; g++) {
        const gp = sub + 16 + g * 12;
        if (gp + 12 > data.length) break;
        const sc = u32(gp), ec = u32(gp + 4), sg = u32(gp + 8);
        for (let c = sc; c <= ec && c - sc < 65536; c++) { pc.push(c); pg.push(sg + (c - sc)); }
      }
    }
    for (let q = 0; q < pc.length; q++) {
      const code = pc[q], gid = pg[q];
      if (isUni) {
        maps.hasUni = true;
        if (gid !== 0 && !maps.gidToUni.has(gid)) maps.gidToUni.set(gid, code);
      } else if (isSym) { if (!maps.codeToGid.has(code & 0xff)) maps.codeToGid.set(code & 0xff, gid); }
      else if (isMac) { if (!maps.codeToGid.has(code)) maps.codeToGid.set(code, gid); }
    }
  }
  return maps;
}

// ---------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------
interface FontInfo {
  composite: boolean;
  ranges: CodeRange[];
  toUni: CMapData | null;        // ToUnicode
  encCMap: CMapData | null;      // composite: embedded encoding CMap (code -> CID); null = Identity
  simple: string[];              // simple fonts: code -> unicode ("" unknown)
  widths: Map<number, number>;   // simple: by code; composite: by CID
  defaultWidth: number;
  stdWidths: number[] | null;    // standard-14 fallback (index code-32)
  type3: boolean;
  fontMatrix: number[];
  tt: TtMaps | null;             // embedded TrueType cmap (fallback mapping)
  cidToGid: Uint8Array | null;   // CIDToGIDMap stream (uint16 BE), null = identity
  spaceWidth: number;
  ocrFont: boolean;              // font name typical for OCR text layers (Tesseract "GlyphLessFont")
}

interface Glyph { code: number; u: string; w: number; isSpace: boolean }

class FontLoader {
  doc: PdfDoc;
  cache: Map<PDict, FontInfo>;
  fallbackFont: FontInfo | null;
  constructor(doc: PdfDoc) {
    this.doc = doc;
    this.cache = new Map<PDict, FontInfo>();
    this.fallbackFont = null;
  }

  load(fontObj: PObj | undefined): FontInfo | null {
    const d = this.doc.dictOf(fontObj);
    if (!d) return null;
    const hit = this.cache.get(d);
    if (hit !== undefined) return hit;
    let f: FontInfo;
    try { f = this.build(d); } catch (e) { this.doc.warnings.push("font: " + String(e)); f = this.build(mkDict()); }
    this.cache.set(d, f);
    return f;
  }

  fallback(): FontInfo {
    // Helvetica/WinAnsi stand-in for missing font resources
    if (!this.fallbackFont) {
      const d = mkDict();
      d.m.set("BaseFont", mkName("Helvetica"));
      d.m.set("Subtype", mkName("Type1"));
      d.m.set("Encoding", mkName("WinAnsiEncoding"));
      this.fallbackFont = this.build(d);
    }
    return this.fallbackFont;
  }

  private build(d: PDict): FontInfo {
    const doc = this.doc;
    const subtype = doc.nameOf(d.m.get("Subtype"));
    const f: FontInfo = {
      composite: subtype === "Type0",
      ranges: [],
      toUni: null,
      encCMap: null,
      simple: [],
      widths: new Map<number, number>(),
      defaultWidth: 0,
      stdWidths: null,
      type3: subtype === "Type3",
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      tt: null,
      cidToGid: null,
      spaceWidth: 250,
      ocrFont: /GlyphLess/i.test(doc.nameOf(d.m.get("BaseFont"))),
    };
    // ToUnicode
    const tu = doc.resolve(d.m.get("ToUnicode"));
    if (isStream(tu)) {
      try { f.toUni = parseCMap(doc.streamText(tu), "uni"); } catch (e) { doc.warnings.push("ToUnicode: " + String(e)); }
    }
    let descriptor: PDict | null = null;
    if (f.composite) {
      const desc = doc.arrOf(d.m.get("DescendantFonts"));
      const cid = desc.length > 0 ? doc.dictOf(desc[0]) : null;
      descriptor = cid ? doc.dictOf(cid.m.get("FontDescriptor")) : null;
      const enc = doc.resolve(d.m.get("Encoding"));
      if (isStream(enc)) {
        try { f.encCMap = parseCMap(doc.streamText(enc), "cid"); } catch (e) { /* ignore */ }
        if (f.encCMap && f.encCMap.ranges.length > 0) f.ranges = f.encCMap.ranges.slice(0);
      } else if (isName(enc) && enc.v.indexOf("Identity") !== 0) {
        // predefined (CJK) CMaps are not embedded; we can only use ToUnicode
        if (enc.v.indexOf("UCS2") >= 0 || enc.v.indexOf("UTF16") >= 0) f.ranges = [{ nBytes: 2, lo: 0, hi: 0xffff }];
      }
      // Identity-H/V codes are always 2 bytes, whatever codespace the ToUnicode CMap declares (R6)
      if (isName(enc) && enc.v.indexOf("Identity") === 0) f.ranges = [{ nBytes: 2, lo: 0, hi: 0xffff }];
      if (f.ranges.length === 0 && f.toUni && f.toUni.ranges.length > 0) f.ranges = f.toUni.ranges.slice(0);
      if (f.ranges.length === 0) f.ranges = [{ nBytes: 2, lo: 0, hi: 0xffff }];
      f.defaultWidth = cid ? doc.num(cid.m.get("DW"), 1000) : 1000;
      if (cid) this.parseW(doc.arrOf(cid.m.get("W")), f.widths);
      const c2g = cid ? doc.resolve(cid.m.get("CIDToGIDMap")) : null;
      if (isStream(c2g)) f.cidToGid = doc.streamData(c2g);
      // embedded TrueType program for the fallback mapping
      const ff = descriptor ? doc.resolve(descriptor.m.get("FontFile2")) : null;
      const ff3 = descriptor ? doc.resolve(descriptor.m.get("FontFile3")) : null;
      const prog = isStream(ff) ? ff : isStream(ff3) ? ff3 : null;
      if (prog && (!f.toUni || f.toUni.single.size + f.toUni.rangeList.length === 0)) {
        try { f.tt = parseTrueTypeCmap(doc.streamData(prog)); } catch (e) { /* ignore */ }
      }
      f.spaceWidth = this.cidWidth(f, 32) || 250;
    } else {
      descriptor = doc.dictOf(d.m.get("FontDescriptor"));
      const flags = descriptor ? doc.num(descriptor.m.get("Flags"), 0) : 0;
      const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
      const baseFont = doc.nameOf(d.m.get("BaseFont"));
      // base encoding
      let base: number[] = subtype === "TrueType" ? ENC_WINANSI : ENC_STANDARD;
      if (symbolic && subtype === "TrueType") base = ENC_WINANSI;
      const enc = doc.resolve(d.m.get("Encoding"));
      let encName = "";
      let diffs: PObj[] = [];
      if (isName(enc)) encName = enc.v;
      else if (isDict(enc)) { encName = doc.nameOf(enc.m.get("BaseEncoding")); diffs = doc.arrOf(enc.m.get("Differences")); }
      if (encName === "WinAnsiEncoding") base = ENC_WINANSI;
      else if (encName === "MacRomanEncoding") base = ENC_MACROMAN;
      else if (encName === "StandardEncoding" || encName === "MacExpertEncoding") base = ENC_STANDARD;
      for (let c = 0; c < 256; c++) f.simple.push(base[c] ? String.fromCharCode(base[c]) : "");
      if (f.type3) for (let c = 0; c < 256; c++) f.simple[c] = "";
      let code = 0;
      for (const x of diffs) {
        const r = doc.resolve(x);
        if (isNum(r)) code = r | 0;
        else if (isName(r)) { if (code >= 0 && code < 256) f.simple[code] = glyphNameToUnicode(r.v); code++; }
      }
      // embedded TrueType cmap for symbolic fonts without usable encoding
      if (subtype === "TrueType" && descriptor && !isDict(enc) && (!f.toUni || f.toUni.single.size + f.toUni.rangeList.length === 0)) {
        const ff = doc.resolve(descriptor.m.get("FontFile2"));
        if (isStream(ff)) { try { f.tt = parseTrueTypeCmap(doc.streamData(ff)); } catch (e) { /* ignore */ } }
      }
      // widths
      if (f.type3) {
        const fm = doc.numArr(d.m.get("FontMatrix"), 0);
        if (fm.length === 6) f.fontMatrix = fm;
      }
      const firstChar = doc.num(d.m.get("FirstChar"), 0);
      const widths = doc.arrOf(d.m.get("Widths"));
      for (let i = 0; i < widths.length; i++) {
        const w = doc.num(widths[i], -1);
        if (w >= 0) f.widths.set(firstChar + i, f.type3 ? w * f.fontMatrix[0] * 1000 : w);
      }
      f.defaultWidth = descriptor ? doc.num(descriptor.m.get("MissingWidth"), 0) : 0;
      if (widths.length === 0) {
        const bold = /bold|black|heavy|semibold/i.test(baseFont) || (descriptor ? doc.num(descriptor.m.get("FontWeight"), 400) >= 600 : false);
        if (/courier|mono/i.test(baseFont)) { f.stdWidths = null; f.defaultWidth = 600; }
        else if (/times|serif|georgia|garamond|book|roman/i.test(baseFont)) f.stdWidths = bold ? W_TIMESB : W_TIMES;
        else f.stdWidths = bold ? W_HELVB : W_HELV;
        if (!f.stdWidths && f.defaultWidth === 0) f.defaultWidth = 500;
      }
      f.spaceWidth = this.simpleWidth(f, 32) || 250;
    }
    return f;
  }

  private parseW(w: PObj[], out: Map<number, number>): void {
    const doc = this.doc;
    let i = 0;
    while (i < w.length) {
      const a = doc.resolve(w[i]);
      if (!isNum(a)) { i++; continue; }
      const b = doc.resolve(w[i + 1]);
      if (isArr(b)) {
        for (let k = 0; k < b.v.length; k++) out.set(a + k, doc.num(b.v[k], 1000));
        i += 2;
      } else if (isNum(b)) {
        const wv = doc.num(w[i + 2], 1000);
        if (b >= a && b - a < 65536) for (let c = a; c <= b; c++) out.set(c, wv);
        i += 3;
      } else i++;
    }
  }

  simpleWidth(f: FontInfo, code: number): number {
    const w = f.widths.get(code);
    if (w !== undefined) return w;
    if (f.stdWidths && code >= 32 && code < 256) {
      const sw = f.stdWidths[code - 32];
      if (sw > 0) return sw;
    }
    return f.defaultWidth > 0 ? f.defaultWidth : (f.stdWidths ? 500 : 0);
  }

  cidWidth(f: FontInfo, cid: number): number {
    const w = f.widths.get(cid);
    return w !== undefined ? w : f.defaultWidth;
  }

  decode(f: FontInfo, s: string): Glyph[] {
    // Splits a PDF string into glyphs (code, unicode, width/1000).
    const out: Glyph[] = [];
    if (!f.composite) {
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i) & 0xff;
        let u: string | null = f.toUni ? cmapLookup(f.toUni, code) : null;
        if (u === null) {
          u = f.simple[code];
          if (u === "" && f.tt) {
            let gid = f.tt.codeToGid.get(code);
            if (gid === undefined) gid = f.tt.codeToGid.get(0xf000 | code);
            if (gid !== undefined) { const g = f.tt.gidToUni.get(gid); if (g !== undefined) u = g <= 0xffff ? String.fromCharCode(g) : String.fromCharCode(0xd800 + ((g - 0x10000) >> 10), 0xdc00 + ((g - 0x10000) & 0x3ff)); }
          }
          if (u === "" && code >= 32) u = ENC_WINANSI[code] ? String.fromCharCode(ENC_WINANSI[code]) : "";
        }
        out.push({ code: code, u: u, w: this.simpleWidth(f, code), isSpace: code === 32 });
      }
      return out;
    }
    // composite: segment by codespace ranges
    let i = 0;
    while (i < s.length) {
      let n = 0, code = 0;
      let matched = false;
      for (const r of f.ranges) {
        if (i + r.nBytes > s.length) continue;
        let v = 0;
        for (let k = 0; k < r.nBytes; k++) v = (v << 8) | (s.charCodeAt(i + k) & 0xff);
        v = v >>> 0;
        if (v >= r.lo && v <= r.hi) { n = r.nBytes; code = v; matched = true; break; }
      }
      if (!matched) {
        n = Math.min(f.ranges[0].nBytes, s.length - i);
        code = 0;
        for (let k = 0; k < n; k++) code = (code << 8) | (s.charCodeAt(i + k) & 0xff);
        code = code >>> 0;
      }
      i += n;
      const cid = f.encCMap ? cmapLookupCid(f.encCMap, code) : code;
      let u: string | null = f.toUni ? cmapLookup(f.toUni, code) : null;
      if (u === null && f.tt) {
        let gid = cid;
        if (f.cidToGid && cid * 2 + 1 < f.cidToGid.length) gid = (f.cidToGid[cid * 2] << 8) | f.cidToGid[cid * 2 + 1];
        const g = f.tt.gidToUni.get(gid);
        if (g !== undefined) u = g <= 0xffff ? String.fromCharCode(g) : String.fromCharCode(0xd800 + ((g - 0x10000) >> 10), 0xdc00 + ((g - 0x10000) & 0x3ff));
      }
      if (u === null) u = "";
      out.push({ code: code, u: u, w: this.cidWidth(f, cid), isSpace: n === 1 && code === 32 });
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Content stream interpreter -> positioned text items
// ---------------------------------------------------------------------
// flip: kept for compatibility, always false (item y is in y-up user space, see R4)
interface TextItem { x: number; y: number; w: number; h: number; s: string; sp: number; page: number; flip: boolean; rot: number }

type Mat = [number, number, number, number, number, number];

function matMul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

// tr: text render mode (3 and 7 = invisible); fa / sa: fill / stroke alpha (ExtGState ca / CA);
// mask / blend: an ExtGState soft mask or a non-normal blend mode is active
interface GState { ctm: Mat; font: FontInfo | null; size: number; charSp: number; wordSp: number; hscale: number; leading: number; rise: number; tr: number; fa: number; sa: number; mask: boolean; blend: boolean }

function copyGState(g: GState): GState {
  return { ctm: g.ctm, font: g.font, size: g.size, charSp: g.charSp, wordSp: g.wordSp, hscale: g.hscale, leading: g.leading, rise: g.rise, tr: g.tr, fa: g.fa, sa: g.sa, mask: g.mask, blend: g.blend };
}

function newGState(ctm: Mat): GState {
  return { ctm: ctm, font: null, size: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0, tr: 0, fa: 1, sa: 1, mask: false, blend: false };
}

function invisibleText(gs: GState): boolean {
  // text that paints nothing: render mode 3/7, or zero alpha for the parts the mode paints
  // (Apple's Vision OCR layer uses an ExtGState with /ca 0 instead of 3 Tr)
  const tr = gs.tr;
  if (tr === 3 || tr === 7) return true;
  const fill = tr === 0 || tr === 2 || tr === 4 || tr === 6, stroke = tr === 1 || tr === 2 || tr === 5 || tr === 6;
  return (!fill || gs.fa < 0.01) && (!stroke || gs.sa < 0.01);
}

// Extraction statistics: glyph counts for the OCR and Unicode checks.
// glyphsOcr: invisible (Tr 3/7) or OCR-font glyphs; glyphsCovered: visible glyphs later painted over
// by a page-filling opaque image ("text under image" OCR); glyphsOnImagePages: other visible glyphs
// on pages with a page-filling image; glyphsNoUni: glyphs without a Unicode mapping.
class ContentInterpreter {
  doc: PdfDoc;
  items: TextItem[];
  fonts: FontLoader;
  formDepth: number;
  ops: number;
  deadline: number;
  glyphsTotal: number;
  glyphsOcr: number;
  glyphsCovered: number;
  glyphsOnImagePages: number;
  glyphsNoUni: number;
  pageNative: number;
  pageArea: number;
  pageHasImage: boolean;
  pagesWithImage: number;
  ocHidden: number;
  box: number[];

  constructor(doc: PdfDoc) {
    this.doc = doc;
    this.items = [];
    this.fonts = new FontLoader(doc);
    this.formDepth = 0;
    this.ops = 0;
    this.deadline = runDeadline; // one budget for the whole run, set in main
    this.glyphsTotal = 0;
    this.glyphsOcr = 0;
    this.glyphsCovered = 0;
    this.glyphsOnImagePages = 0;
    this.glyphsNoUni = 0;
    this.pageNative = 0;
    this.pageArea = 0;
    this.pageHasImage = false;
    this.pagesWithImage = 0;
    this.ocHidden = 0;
    this.box = [];
  }

  beginPage(box: number[]): void {
    this.box = box;
    this.pageArea = Math.abs((box[2] - box[0]) * (box[3] - box[1]));
    this.pageNative = 0;
    this.pageHasImage = false;
    this.ocHidden = 0;
  }

  endPage(): void {
    if (this.pageHasImage) {
      this.glyphsOnImagePages += this.pageNative;
      this.pagesWithImage++;
    }
    this.pageNative = 0;
  }

  runPage(content: string, resources: PDict | null, page: number): void {
    this.run(content, resources, newGState([1, 0, 0, 1, 0, 0]), page, new Set<number>());
  }

  runAnnotations(pageDict: PDict, resources: PDict | null, page: number): void {
    // Text inside form-field / annotation appearance streams (filled AcroForms, stamps)
    const doc = this.doc;
    const annots = doc.arrOf(pageDict.m.get("Annots"));
    for (const a of annots) {
      const ad = doc.dictOf(a);
      if (!ad) continue;
      const sub = doc.nameOf(ad.m.get("Subtype"));
      if (sub === "Link" || sub === "Popup") continue;
      const flags = doc.num(ad.m.get("F"), 0);
      if (flags & 34) continue; // Hidden (2) or NoView (32)
      if (doc.isHiddenOC(ad.m.get("OC"))) continue;
      // signature fields (/FT /Sig on the widget or inherited from a parent field, or a signature value
      // with /ByteRange): the signature box is not document text and must not mix into the amount lines
      let ft = doc.nameOf(ad.m.get("FT"));
      let parent = doc.dictOf(ad.m.get("Parent"));
      for (let k = 0; ft === "" && parent && k < 16; k++) {
        ft = doc.nameOf(parent.m.get("FT"));
        parent = doc.dictOf(parent.m.get("Parent"));
      }
      if (ft === "Sig") continue;
      const sigValue = sub === "Widget" ? doc.dictOf(ad.m.get("V")) : null;
      if (sigValue && sigValue.m.has("ByteRange")) continue;
      const ap = doc.dictOf(ad.m.get("AP"));
      if (!ap) continue;
      let n = doc.resolve(ap.m.get("N"));
      if (isDict(n)) { // appearance sub-dictionary keyed by state
        const as = doc.nameOf(ad.m.get("AS"));
        const pick: PObj | undefined = as !== "" ? n.m.get(as) : (n.m.size > 0 ? n.m.values().next().value : undefined);
        n = doc.resolve(pick);
      }
      if (!isStream(n)) continue;
      if (doc.isHiddenOC(n.d.m.get("OC"))) continue;
      const rect = doc.numArr(ad.m.get("Rect"), 0);
      const bbox = doc.numArr(n.d.m.get("BBox"), 0);
      let ctm: Mat = [1, 0, 0, 1, 0, 0];
      const mtx = doc.numArr(n.d.m.get("Matrix"), 0);
      if (mtx.length === 6) ctm = [mtx[0], mtx[1], mtx[2], mtx[3], mtx[4], mtx[5]];
      if (rect.length === 4 && bbox.length === 4) {
        // map transformed BBox onto Rect (PDF 12.5.5 algorithm, simplified: translate + scale)
        const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map((c) => [ctm[0] * c[0] + ctm[2] * c[1] + ctm[4], ctm[1] * c[0] + ctm[3] * c[1] + ctm[5]]);
        const minX = Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]), maxX = Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
        const minY = Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]), maxY = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
        const rx0 = Math.min(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]), rx1 = Math.max(rect[0], rect[2]), ry1 = Math.max(rect[1], rect[3]);
        const sx = maxX - minX > 1e-6 ? (rx1 - rx0) / (maxX - minX) : 1, sy = maxY - minY > 1e-6 ? (ry1 - ry0) / (maxY - minY) : 1;
        ctm = matMul(ctm, [sx, 0, 0, sy, rx0 - minX * sx, ry0 - minY * sy]);
      }
      const res = doc.dictOf(n.d.m.get("Resources")) || resources;
      try { this.run(doc.streamText(n), res, newGState(ctm), page, new Set<number>([n.id])); } catch (e) { doc.warnings.push("annotation: " + String(e)); }
    }
  }

  private showText(gs: GState, tm: Mat, str: string, page: number): Mat {
    // returns the text matrix advanced past the shown string
    const f = gs.font;
    if (!f) {
      // no font selected: still advance roughly so following text is placed sensibly
      return matMul([1, 0, 0, 1, str.length * 0.5 * gs.size * gs.hscale, 0], tm);
    }
    const glyphs = this.fonts.decode(f, str);
    const trm: Mat = matMul(matMul([gs.size * gs.hscale, 0, 0, gs.size, 0, gs.rise], tm), gs.ctm);
    const scale = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]) / Math.max(gs.size * gs.hscale, 1e-9);
    let text = "";
    let advance = 0; // text space units (before hscale)
    let noUni = 0;
    for (const g of glyphs) {
      const w0 = g.w / 1000;
      let tx = w0 * gs.size + gs.charSp;
      if (g.isSpace) tx += gs.wordSp;
      advance += tx;
      text += g.u;
      const c0 = g.u.length > 0 ? g.u.charCodeAt(0) : 0;
      if (c0 === 0 || c0 === 0xfffd || (c0 >= 0xe000 && c0 <= 0xf8ff)) noUni++;
    }
    // some producers (Chrome/Skia) map the space glyph to a line break: keep text runs on one line
    if (/[\t\n\v\f\r]/.test(text)) text = text.replace(/[\t\n\v\f\r]/g, " ");
    const devW = advance * gs.hscale * scale;
    const devH = Math.abs(gs.size * Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]) / Math.max(gs.size, 1e-9));
    if (this.ocHidden === 0 && glyphs.length > 0) {
      // statistics for the OCR / Unicode checks (text in hidden optional content does not count)
      this.glyphsTotal += glyphs.length;
      this.glyphsNoUni += noUni;
      if (f.ocrFont || invisibleText(gs)) this.glyphsOcr += glyphs.length;
      else this.pageNative += glyphs.length;
    }
    if (text.length > 0 && this.ocHidden === 0) {
      let rot = Math.round(Math.atan2(trm[1], trm[0]) / (Math.PI / 2)) % 4;
      if (rot < 0) rot += 4;
      this.items.push({ x: trm[4], y: trm[5], w: devW, h: devH > 0 ? devH : Math.abs(gs.size * scale), s: text, sp: (f.spaceWidth / 1000) * gs.size * gs.hscale * scale, page: page, flip: false, rot: rot });
    }
    return matMul([1, 0, 0, 1, advance * gs.hscale, 0], tm);
  }

  private paintImage(gs: GState, img: PDict | null): void {
    // a page-filling opaque image: text drawn before it on this page is hidden under the image
    if (gs.fa < 0.99 || gs.mask || gs.blend || this.pageArea <= 0) return;
    if (img && (img.m.has("SMask") || img.m.has("Mask") || this.doc.resolve(img.m.get("ImageMask")) === true)) return;
    const m = gs.ctm;
    const area = Math.abs(m[0] * m[3] - m[1] * m[2]);
    if (area < 0.5 * this.pageArea) return;
    this.pageHasImage = true;
    this.glyphsCovered += this.pageNative;
    this.pageNative = 0;
  }

  private extGState(gs: GState, resources: PDict | null, name: PObj): void {
    // transparency from an ExtGState (fill alpha, soft mask, blend mode)
    if (!isName(name) || !resources) return;
    const doc = this.doc;
    const egs = doc.dictOf(resources.m.get("ExtGState"));
    const d = egs ? doc.dictOf(egs.m.get(name.v)) : null;
    if (!d) return;
    if (d.m.has("ca")) gs.fa = doc.num(d.m.get("ca"), 1);
    if (d.m.has("CA")) gs.sa = doc.num(d.m.get("CA"), 1);
    const sm = d.m.get("SMask");
    if (sm !== undefined) gs.mask = doc.nameOf(sm) !== "None";
    if (d.m.has("BM")) {
      const bm = doc.nameOf(d.m.get("BM"));
      gs.blend = bm !== "" && bm !== "Normal" && bm !== "Compatible";
    }
  }

  private run(content: string, resources: PDict | null, gsIn: GState, page: number, visited: Set<number>): void {
    const doc = this.doc;
    const lx = new Lexer(content, 0);
    const stack: PObj[] = [];
    const gsStack: GState[] = [];
    const mcStack: boolean[] = []; // marked content: true = hidden optional content
    let gs: GState = gsIn;
    let tm: Mat = [1, 0, 0, 1, 0, 0];
    let tlm: Mat = [1, 0, 0, 1, 0, 0];
    const fontDict = resources ? doc.dictOf(resources.m.get("Font")) : null;
    const xobjDict = resources ? doc.dictOf(resources.m.get("XObject")) : null;

    let guard = 0;
    for (;;) {
      if (++guard > 5000000) { doc.flagIncomplete("operator limit reached"); break; }
      if ((guard & 4095) === 0 && Date.now() > this.deadline) {
        doc.warnings.push("time budget exhausted, text truncated");
        doc.flagIncomplete("time budget exhausted");
        break;
      }
      let o: PObj | null;
      try { o = lx.parse(0); } catch (e) { doc.flagIncomplete("content stream could not be parsed"); break; }
      if (o === null) { if (lx.pos >= content.length) break; stack.push(null); continue; }
      if (!isKw(o)) { stack.push(o); if (stack.length > 64) stack.shift(); continue; }
      const op = o.v;
      this.ops++;
      const n = (i: number): number => { const v = stack[stack.length - i]; return typeof v === "number" ? v : 0; };
      switch (op) {
        case "q": gsStack.push(copyGState(gs)); if (gsStack.length > 256) gsStack.shift(); break;
        case "Q": { const p = gsStack.pop(); if (p) gs = p; break; }
        case "cm": if (stack.length >= 6) gs.ctm = matMul([n(6), n(5), n(4), n(3), n(2), n(1)], gs.ctm); break;
        case "gs": this.extGState(gs, resources, stack[stack.length - 1]); break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case "ET": break;
        case "Tf": {
          gs.size = n(1);
          const nm = stack[stack.length - 2];
          let fobj: PObj | undefined = undefined;
          if (isName(nm) && fontDict) fobj = fontDict.m.get(nm.v);
          const loaded = fobj !== undefined ? this.fonts.load(fobj) : null;
          gs.font = loaded ? loaded : (gs.font ? gs.font : this.fonts.fallback());
          break;
        }
        case "Td": tlm = matMul([1, 0, 0, 1, n(2), n(1)], tlm); tm = tlm; break;
        case "TD": gs.leading = -n(1); tlm = matMul([1, 0, 0, 1, n(2), n(1)], tlm); tm = tlm; break;
        case "Tm": if (stack.length >= 6) { tlm = [n(6), n(5), n(4), n(3), n(2), n(1)]; tm = tlm; } break;
        case "T*": tlm = matMul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; break;
        case "TL": gs.leading = n(1); break;
        case "Tc": gs.charSp = n(1); break;
        case "Tw": gs.wordSp = n(1); break;
        case "Tz": gs.hscale = n(1) / 100; break;
        case "Ts": gs.rise = n(1); break;
        case "Tr": gs.tr = n(1); break;
        case "Tj": { const s = stack[stack.length - 1]; if (isStr(s)) tm = this.showText(gs, tm, s.v, page); break; }
        case "'": { tlm = matMul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; const s = stack[stack.length - 1]; if (isStr(s)) tm = this.showText(gs, tm, s.v, page); break; }
        case "\"": { gs.wordSp = n(3); gs.charSp = n(2); tlm = matMul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; const s = stack[stack.length - 1]; if (isStr(s)) tm = this.showText(gs, tm, s.v, page); break; }
        case "TJ": {
          const a = stack[stack.length - 1];
          if (isArr(a)) {
            for (const el of a.v) {
              if (isStr(el)) tm = this.showText(gs, tm, el.v, page);
              else if (isNum(el)) tm = matMul([1, 0, 0, 1, (-el / 1000) * gs.size * gs.hscale, 0], tm);
            }
          }
          break;
        }
        case "BMC": mcStack.push(false); break;
        case "BDC": {
          let hidden = false;
          const tag = stack[stack.length - 2];
          if (isName(tag) && tag.v === "OC") {
            const prop = stack[stack.length - 1];
            if (isName(prop)) {
              const props = resources ? doc.dictOf(resources.m.get("Properties")) : null;
              hidden = props ? doc.isHiddenOC(props.m.get(prop.v)) : false;
            } else if (isDict(prop)) hidden = doc.isHiddenOC(prop);
          }
          mcStack.push(hidden);
          if (hidden) this.ocHidden++;
          break;
        }
        case "EMC": { const h = mcStack.pop(); if (h === true) this.ocHidden--; break; }
        case "Do": {
          const nm = stack[stack.length - 1];
          if (isName(nm) && xobjDict) {
            const xo = doc.resolve(xobjDict.m.get(nm.v));
            if (!isStream(xo) || doc.isHiddenOC(xo.d.m.get("OC"))) break;
            const subtype = doc.nameOf(xo.d.m.get("Subtype"));
            if (subtype === "Image") {
              if (this.ocHidden === 0) this.paintImage(gs, xo.d);
            } else if (subtype === "Form" && !visited.has(xo.id)) {
              if (this.formDepth >= 12) { doc.flagIncomplete("form XObjects nested too deeply"); break; }
              // many small forms calling each other never reach the per-stream check below
              if (Date.now() > this.deadline) { doc.flagIncomplete("time budget exhausted"); break; }
              visited.add(xo.id);
              this.formDepth++;
              const saved = gs;
              const sub = copyGState(gs);
              const mtx = doc.arrOf(xo.d.m.get("Matrix"));
              if (mtx.length === 6) sub.ctm = matMul([doc.num(mtx[0], 1), doc.num(mtx[1], 0), doc.num(mtx[2], 0), doc.num(mtx[3], 1), doc.num(mtx[4], 0), doc.num(mtx[5], 0)], sub.ctm);
              const res = doc.dictOf(xo.d.m.get("Resources")) || resources;
              try { this.run(doc.streamText(xo), res, sub, page, visited); } catch (e) { doc.warnings.push("XObject " + nm.v + ": " + String(e)); doc.flagIncomplete("form XObject " + nm.v + " could not be read"); }
              gs = saved;
              this.formDepth--;
              visited.delete(xo.id);
            }
          }
          break;
        }
        case "BI": {
          // inline image: skip "... ID <binary> EI"
          const s = content;
          let p = lx.pos;
          const idIdx = s.indexOf("ID", p);
          if (idIdx < 0) { lx.pos = s.length; break; }
          if (this.ocHidden === 0 && !/\/(IM|ImageMask)\s+true/.test(s.substring(p, idIdx))) this.paintImage(gs, null);
          p = idIdx + 3;
          for (;;) {
            const ei = s.indexOf("EI", p);
            if (ei < 0) { p = s.length; break; }
            const before = s.charCodeAt(ei - 1), after = ei + 2 < s.length ? s.charCodeAt(ei + 2) : 32;
            if (isWs(before) && (isWs(after) || isDelim(after))) { p = ei + 2; break; }
            p = ei + 2;
          }
          lx.pos = p;
          break;
        }
        default: break;
      }
      stack.length = 0;
    }
    if (lx.unterminated) doc.flagIncomplete("unterminated string in a content stream");
    // unbalanced BDC inside this stream must not hide text outside it
    for (const h of mcStack) if (h) this.ocHidden--;
  }

  private deskew(): void {
    // Skewed scans with an OCR layer: estimate the page's text angle from consecutive items in
    // stream order (words of one line) and rotate the positions back. Native text gives 0.
    const byPage = new Map<number, number[]>();
    const items = this.items;
    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i], b = items[i + 1];
      if (a.page !== b.page || a.rot !== 0 || b.rot !== 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx <= Math.max(a.h, 1) || Math.abs(dy) > dx * 0.0875) continue; // within 5 degrees
      let list = byPage.get(a.page);
      if (!list) { list = []; byPage.set(a.page, list); }
      list.push(Math.atan2(dy, dx));
    }
    for (const [page, angles] of Array.from(byPage.entries())) {
      if (angles.length < 4) continue;
      angles.sort((p, q) => p - q);
      const med = angles[angles.length >> 1];
      if (Math.abs(med) < 0.0017) continue; // < 0.1 degree
      // native text: many neighbours share the exact same baseline; a skewed scan has (almost) none
      let flat = 0;
      for (const ang of angles) if (Math.abs(ang) < 0.0001) flat++;
      if (flat * 4 >= angles.length) continue;
      const c = Math.cos(med), sn = Math.sin(med);
      for (const it of items) {
        if (it.page !== page || it.rot !== 0) continue;
        const x = it.x, y = it.y;
        it.x = x * c + y * sn;
        it.y = -x * sn + y * c;
      }
    }
  }

  finishItems(boxes: number[][]): TextItem[] {
    // Drops text outside the page box (when most of the page's text is inside it), straightens
    // skewed OCR pages and drops text drawn twice at (almost) the same place (same string,
    // > 50 % overlap along the line). boxes[i] is the box of page i.
    this.items = dropOffPage(this.items, boxes);
    this.deskew();
    const out: TextItem[] = [];
    const buckets = new Map<string, TextItem[]>();
    for (const it of this.items) {
      // coordinates along (u) and across (v) the text direction
      const u = it.rot === 0 ? it.x : it.rot === 1 ? it.y : it.rot === 2 ? -it.x : -it.y;
      const v = it.rot === 0 ? it.y : it.rot === 1 ? -it.x : it.rot === 2 ? -it.y : it.x;
      const b = Math.floor(v / 4);
      let dup = false;
      for (let k = b - 1; k <= b + 1 && !dup; k++) {
        const list = buckets.get(it.page + "|" + it.rot + "|" + k + "|" + it.s);
        if (!list) continue;
        for (const o of list) {
          const ou = o.rot === 0 ? o.x : o.rot === 1 ? o.y : o.rot === 2 ? -o.x : -o.y;
          const ov = o.rot === 0 ? o.y : o.rot === 1 ? -o.x : o.rot === 2 ? -o.y : o.x;
          const h = Math.max(it.h, o.h, 1);
          if (Math.abs(ov - v) > 0.5 * h) continue;
          const minW = Math.min(it.w, o.w);
          if (minW < 0.01) { if (Math.abs(ou - u) < 0.15 * h) { dup = true; break; } continue; }
          const overlap = Math.min(u + it.w, ou + o.w) - Math.max(u, ou);
          if (overlap > 0.5 * minW) { dup = true; break; }
        }
      }
      if (dup) continue;
      const key = it.page + "|" + it.rot + "|" + b + "|" + it.s;
      let own = buckets.get(key);
      if (!own) { own = []; buckets.set(key, own); }
      own.push(it);
      out.push(it);
    }
    return out;
  }
}

function dropOffPage(items: TextItem[], boxes: number[][]): TextItem[] {
  // Drops items outside their page box (+ margin) when most items of that page are inside;
  // boxes[i] belongs to page i.
  const inside = new Map<number, number>(), outside = new Map<number, number>();
  const flags: boolean[] = [];
  for (const it of items) {
    const b = boxes[it.page];
    let ok = true;
    if (b && b.length === 4 && b[2] - b[0] > 1 && b[3] - b[1] > 1) {
      const m = 10;
      ok = it.x >= b[0] - m && it.x <= b[2] + m && it.y >= b[1] - m && it.y <= b[3] + m;
    }
    flags.push(ok);
    const map = ok ? inside : outside;
    map.set(it.page, (map.get(it.page) || 0) + 1);
  }
  const out: TextItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i].page;
    if (flags[i] || (inside.get(p) || 0) < (outside.get(p) || 0)) out.push(items[i]);
  }
  return out;
}

// ---------------------------------------------------------------------
// Line assembly
// ---------------------------------------------------------------------
// Largest glyph height of every line of the last assembleLines call (0 for a page break); pickAmount uses it to find the title.
let lastLineHeights: number[] = [];

function assembleLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  const heights: number[] = [];
  let page = -1;
  // group per page, sort by y desc then x asc
  const byPage = new Map<number, TextItem[]>();
  for (const it of items) {
    let arr = byPage.get(it.page);
    if (!arr) { arr = []; byPage.set(it.page, arr); }
    arr.push(it);
  }
  const pageNums: number[] = [];
  for (const k of Array.from(byPage.keys())) pageNums.push(k);
  pageNums.sort((a, b) => a - b);
  for (const pn of pageNums) {
    const arr = byPage.get(pn) as TextItem[];
    if (page >= 0) { lines.push(""); heights.push(0); }
    page = pn;
    // dominant text direction on this page (rotated/landscape text): rotate coordinates back
    const rotCount = [0, 0, 0, 0];
    for (const it of arr) rotCount[it.rot]++;
    let dom = 0;
    for (let k = 1; k < 4; k++) if (rotCount[k] > rotCount[dom]) dom = k;
    if (dom !== 0) {
      for (const it of arr) {
        const x = it.x, y = it.y;
        if (dom === 1) { it.x = y; it.y = -x; }
        else if (dom === 2) { it.x = -x; it.y = -y; }
        else { it.x = -y; it.y = x; }
      }
    }
    let flips = 0;
    for (const it of arr) if (it.flip) flips++;
    const flipped = dom === 0 && flips * 2 > arr.length; // y grows downwards in this page's coordinate system
    arr.sort((a, b) => (flipped ? a.y - b.y : b.y - a.y) || (a.x - b.x));
    // cluster into lines by baseline
    const groups: TextItem[][] = [];
    let cur: TextItem[] = [];
    let curY = 0, curH = 0;
    for (const it of arr) {
      const h = Math.max(it.h, 1);
      const tol = Math.max(0.45 * Math.max(h, curH), 1.5);
      if (cur.length > 0 && Math.abs(it.y - curY) > tol) {
        groups.push(cur);
        cur = [];
      }
      if (cur.length === 0) { curY = it.y; curH = h; }
      cur.push(it);
    }
    if (cur.length > 0) groups.push(cur);
    for (const g of groups) {
      g.sort((a, b) => a.x - b.x);
      let line = "";
      let endX = -1e9;
      let prevText = "";
      let prevX = -1e9;
      let h = 0;
      let maxH = 0;
      for (const it of g) {
        h = Math.max(it.h, 1);
        const t = it.s;
        if (t.length === 0) continue;
        if (it.h > maxH && t.trim().length > 0) maxH = it.h;
        // duplicated text (fake bold / overprint)
        if (t === prevText && Math.abs(it.x - prevX) < 0.15 * h) continue;
        if (endX > -1e8) {
          const gap = it.x - endX;
          const spaceW = it.sp > 0 ? it.sp : 0.25 * h;
          if (gap > 1.6 * h) line += "   ";
          else if (gap > Math.min(0.5 * spaceW, 0.22 * h) && line.length > 0 && !line.endsWith(" ") && !t.startsWith(" ")) line += " ";
        }
        line += t;
        endX = Math.max(endX, it.x + it.w);
        prevText = t;
        prevX = it.x;
      }
      // trailing white space, without a regex (/\s+$/ is quadratic on long runs of inner spaces)
      let e = line.length;
      while (e > 0 && /\s/.test(line.charAt(e - 1))) e--;
      if (e < line.length) line = line.substring(0, e);
      if (line.length > 0) { lines.push(line); heights.push(maxH); }
    }
  }
  lastLineHeights = heights;
  return lines;
}


// ---------------------------------------------------------------------
// Amount extraction
// ---------------------------------------------------------------------
// One amount found in a line: printed text, value and position.
interface AmountMatch { text: string; value: number; index: number; end: number }

// Keyword classes of the label that belongs to one amount.
interface LabelInfo { strong: boolean; payment: boolean; weak: boolean; neg: boolean; ded: boolean }

interface Candidate {
  amount: string; value: number; score: number; line: string; lineIdx: number; method: string;
  pos: number;          // index of the amount within its line, -1 for keyword-next-line
  charIdx: number;      // position of the amount text in its line
  label: LabelInfo;     // own label segment, or the line label for table cells
  lineLabel: boolean;   // amount carries the line's first label (table cell / total row)
  ownLabel: boolean;    // amount has its own text label (not a bare table cell)
  confirmed: boolean;   // backed by arithmetic (column sum, sum check, deduction chain)
  copy: boolean;        // inside an appended invoice copy
  risky: boolean;       // table whose rightmost amount column is Skonto / Rest / Offen
  col: string;          // column class from the table header ("" = unmapped)
}

interface LineInfo {
  text: string;
  amounts: AmountMatch[];
  labels: LabelInfo[];
  lineLabel: boolean[];
  own: boolean[];
  cols: string[];
  pcts: number[];       // percentages written in the line ("2 % Skonto")
  label: LabelInfo;     // keyword classes of the whole line
  header: boolean;
  risky: boolean;
  payBonus: boolean;    // header-mapped payment column counts as a label on this line
  copy: boolean;
  wrapped: string;      // label wrapped around a value-only line ("" if none)
  grossPay: boolean;    // single invoice row under a Netto/USt/Brutto header without payment or deduction column
  payCol: boolean;      // row under a header that has a payment column (Zahlbetrag)
  quoted: boolean;      // quoted part of an e-mail reply
  sents: string[];      // the sentence around each amount (letter text, across wrapped lines)
}

interface AmountPick { best: Candidate | null; candidates: Candidate[]; currency: string; confidence: string; reason: string }

// total and payment labels (also NL, FR, IT, ES, PT, PL, CZ, DA/SV totals, "paid" participles and transfer nouns)
const STRONG_KEYWORDS = /gesamt|zahlbetrag|zahlungsbetrag|überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlungsbetrag|auszahlung\b|gutschriftsbetrag|erstattungsbetrag|endbetrag|endsumme|summe|total|nettobetrag der zahlung|betrag der überweisung|wir überweisen|überwiesen|ueberwiesen|überweisen wir|überweisen ihnen|zahlung in höhe|zahlen wir|wir zahlen|zu zahlen|angewiesen|den betrag von|gutgeschrieben|zu ihren gunsten|betrag der zahlung|überweisung\b|ueberweisung\b|ausgleichsbetrag|gezahlte[rn]? betrag|bezahlte[rn]? betrag|nettozahlung|gutschrift auf ihr konto|remittance total|remittance amount|amount remitted|amount paid|payment amount|net amount paid|net payment|total paid|payment total|check amount|credited amount|amount credited|transfer amount|amount transferred|we have (?:today )?(?:paid|transferred|remitted)|payment of\b|totaal|celkem|\bi alt\b|totalt|\bsumma\b|\bsuma\b|razem|betaald|overgemaakt|overboeking|réglé|reglé|payé|viré|versé|virement|pagato|bonifico|bonificato|pagado|transferencia|transferido|abonado|valor pago|montante pago|total pago|transferência|przelew|przelano|zapłacono|zapłacona|wpłacono|uregulowano|uhrazen|zaplacen|převedeno|betalt|overført|indbetalt|överfört|utbetalt|nous avons (?:réglé|payé|viré|versé)|wij hebben (?:betaald|overgemaakt)|abbiamo (?:pagato|bonificato|saldato)|hemos (?:pagado|transferido|abonado)|efetu[aá]mos|pagámos|transferimos|uhradili jsme|jsme uhradili|zaplatili jsme|jsme zaplatili|převedli jsme|przelaliśmy|zapłaciliśmy|uregulowaliśmy|vi har (?:betalt|overført|betalat|överfört)|montant (?:du |de )?(?:règlement|reglement|paiement|virement)|importo (?:del )?(?:pagamento|bonifico)|importe (?:del )?(?:pago|transferencia)|bedrag (?:van de )?betaling|kwota (?:płatności|przelewu)|částka (?:platby|úhrady)/i;
// words that mean "what was actually paid" (also the foreign participles and transfer nouns) – beat generic totals like "Summe Rechnungsbetrag"
const PAYMENT_KEYWORDS = /zahlbetrag|zahlungsbetrag|überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlung|gutschriftsbetrag|erstattungsbetrag|wir überweisen|überwiesen|ueberwiesen|überweisen wir|überweisen ihnen|zahlung in höhe|zahlen wir|wir zahlen|zu zahlen|angewiesen|den betrag von|gutgeschrieben|zu ihren gunsten|betrag der zahlung|überweisung\b|ueberweisung\b|zahlungssumme|ausgleichsbetrag|gezahlte[rn]? betrag|bezahlte[rn]? betrag|nettozahlung|gutschrift auf ihr konto|remittance total|remittance amount|amount remitted|amount paid|payment amount|net amount paid|net payment|total paid|payment total|check amount|credited amount|amount credited|transfer amount|amount transferred|we have (?:today )?(?:paid|transferred|remitted)|payment of\b|betaald|overgemaakt|overboeking|réglé|reglé|payé|viré|versé|virement|pagato|bonifico|bonificato|pagado|transferencia|transferido|abonado|valor pago|montante pago|total pago|transferência|przelew|przelano|zapłacono|zapłacona|wpłacono|uregulowano|uhrazen|zaplacen|převedeno|betalt|overført|indbetalt|överfört|utbetalt|nous avons (?:réglé|payé|viré|versé)|wij hebben (?:betaald|overgemaakt)|abbiamo (?:pagato|bonificato|saldato)|hemos (?:pagado|transferido|abonado)|efetu[aá]mos|pagámos|transferimos|uhradili jsme|jsme uhradili|zaplatili jsme|jsme zaplatili|převedli jsme|przelaliśmy|zapłaciliśmy|uregulowaliśmy|vi har (?:betalt|overført|betalat|överfört)|montant (?:du |de )?(?:règlement|reglement|paiement|virement)|importo (?:del )?(?:pagamento|bonifico)|importe (?:del )?(?:pago|transferencia)|bedrag (?:van de )?betaling|kwota (?:płatności|przelewu)|částka (?:platby|úhrady)/i;
// explicit label of the transferred amount (the end of a netting): beats computed totals
const TRANSFER_LABEL = /überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlungsbetrag|auszahlbetrag|auszahlung\b|gutschriftsbetrag|erstattungsbetrag|zahlbetrag|zahlungsbetrag|zahlungssumme|überwiesene[rn]? (?:betrag|summe)|gezahlte[rn]? betrag|betrag der überweisung|betrag der zahlung|nettozahlung|amount paid|payment amount|net payment|total paid|amount remitted|remittance (?:amount|total)|transfer amount|amount transferred|check amount|credited amount|amount credited|totaal betaald|betaald bedrag|montant (?:réglé|payé|du virement|viré|versé)|total (?:réglé|payé|pagado|pago)|importo (?:pagato|bonificato|del bonifico)|totale pagato|importe (?:pagado|transferido|de la transferencia)|valor (?:pago|transferido)|montante pago|kwota (?:przelewu|zapłacona|płatności)|zapłacono|uhrazen[áo]|částka platby|zaplacen[áo] částka|betalt beløb|betalt belopp|montant (?:du |de )?(?:règlement|reglement|paiement|virement)|importo (?:del )?(?:pagamento|bonifico)|importe (?:del )?(?:pago|transferencia)|bedrag (?:van de )?betaling|částka úhrady/i;
// payment verbs that follow the amount in a sentence ("3.454,00 EUR überwiesen")
const POST_PAYMENT = /überwiesen|ueberwiesen|überweisen|gutgeschrieben|angewiesen|bezahlt|beglichen|ausgeglichen|transferred|remitted|paid\b|betaald|overgemaakt|réglé|payé|viré|pagato|bonificato|pagado|transferido|zapłacono|przelano|uhrazen|zaplacen|betalt|overført|överfört/i;
// label nouns that must be followed by an amount (safety net)
const PAYMENT_LABEL = /zahlbetrag|zahlungsbetrag|überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlungsbetrag|gutschriftsbetrag|zahlungssumme|betrag der zahlung|payment amount|amount paid|net payment|total paid|credited amount|amount credited/i;
// running totals and balances are no payment, even when worded like one ("Saldo zu Ihren Gunsten", "bisher überwiesen")
const CUMULATIVE = /(?:saldo|guthaben|kontostand)[^.]{0,25}zu ihren gunsten|\bbisher\b/i;
const YEAR_TO_DATE = /year to date|\bytd\b|laufenden jahr|kumuliert/i;
// earlier payments named in a label ("bereits gezahlt", "1. Rate (bereits überwiesen am 15.09.)") and unpaid amounts
const PRIOR = /\bbereits\b|\bschon\b|\bzuvor\b|already|previously|prior payment|déjà|\breeds\b|\bgià\b|\bya\b|\bjiž\b|\bjuż\b|allerede|\bredan\b/i;
const PRIOR_PAID = /gezahlt|bezahlt|überwiesen|ueberwiesen|beglichen|angewiesen|zahlung|paid|payment|betaald|payé|réglé|pagat|pagad|zapłac|uhrazen|zaplacen|betalt/i;
const SENTENCE_VERB = /\b(?:wir|haben|hat|habe|wurde|wurden|we|have|has|nous|avons|wij|hebben|abbiamo|hemos)\b/i;
const NOT_PAID = /obetal|ikke betalt|niet betaald|onbetaald|non pagat|impagad|no pagad|nezaplacen|neuhrazen|niezapłac|impayé|non réglé|unpaid|unbezahlt|nicht bezahlt/i;
const WEAK_KEYWORDS = /betrag|zahlung|überweisung|ueberweisung|amount|payment|bedrag|betaling|montant|paiement|importo|pagamento|importe|\bpago\b|valor|kwota|płatnoś|částka|platba|úhrada|beløb|belopp|betalning|règlement|reglement/i;
const NEGATIVE_KEYWORDS = /skonto|abzug|abzgl|abzüglich|\.\/\.|einbehalt|gebühr|spesen|rabatt|discount|steuer|mwst|(?:^|[^a-zäöüß])ust(?![a-zäöüß])|(?:^|[^a-z])vat(?![a-z])|rechnungsbetrag|rechnungssumme|bruttobetrag|brutto|netto\b|offener|offene|restbetrag|fällig|iban|bic\b|datum|belegnr|beleg-?nr|rechnungsnr|rechnungs-?nummer|kundennr|kunden-?nummer|lieferantennr|seite|page|telefon|tel\.|fax|steuernummer|ust-id|blz|zwischensumme|subtotal|zinsen|mahn|kontostand|saldo|kapital|capital|kreditlimit|guthaben|kurs\b|umrechnung|exchange rate|gross amount|invoice amount|total invoice|instructed amount|charges|gewicht|menge|übertrag|uebertrag|\bvortrag|carried forward|brought forward|seitensumme|summe seite|delkredere|bonus|provision|aufrechn|bauabzug|quellensteuer|withholding|factuurbedrag|montant (?:de la )?facture|montant ttc|importo (?:della )?fattura|importe (?:de la )?factura|kwota faktury|částka faktury|fakturabeløb|fakturabelopp|korting|escompte|remise|sconto|descuento|\brabat\b|sleva|\bbtw\b|\btva\b|\biva\b|\bbruto\b|\bbrut\b|lordo|retenue|ritenuta|retención|à payer|a payer|te betalen|da pagare|a pagar|do zapłaty|k úhradě|k zaplacení|at betale|att betala|amount due|balance due|total due/i;
// deduction labels for the total - deduction = payment chain
const DEDUCTION_KEYWORDS = /skonto|abzug|abzgl|abzüglich|\.\/\.|einbehalt|gebühr|spesen|rabatt|discount|kürzung|minderung|verrechn|aufrechn|gutschrift(?!sbetrag|sanzeige| auf)|credit note|less\b|charges|delkredere|bonus|provision|bauabzug|quellensteuer|withholding|zuschuss|rückvergütung|kostenbeteiligung|korting|escompte|remise|sconto|descuento|\brabat\b|sleva|retenue|ritenuta|retención|potrącen|srážka|fradrag|avdrag/i;
const UNIT_AFTER = /^\s?(?:kg|g|t|to|st|stk|stck|stück|pal|paletten|m|m2|m3|qm|cbm|l|ltr|liter|km|std|min|%|prozent|pct|pcs|pc|ea|lbs?)(?![A-Za-zÄÖÜäöüß0-9])/i;
const UNIT_AFTER_H = /^\s?h(?![A-Za-zÄÖÜäöüß0-9])/; // hours, lower case only
// (a whole word, except "nr" as in "Rechnungsnr." - "zapłacono" / "uhrazeno" are no "No.")
const NUMBER_LABEL_BEFORE = /(?:nr|(?:^|[^a-zäöüßà-ž])(?:no|rg|re|rechnung|pos|position|beleg|invoice|inv|art|artikel|kd|kunde|anzahl|menge|stk|stück)|#)\.?:?\s*$/i;
const CURRENCY_TOKEN = /\b(?:EUR|CHF|USD|GBP|PLN|CZK|SEK|DKK|NOK|HUF|RON|BGN|JPY|CNY|CAD|AUD|TRY)\b|€|\$|£|¥|zł|Kč|\b[Ee][Uu][Rr][Oo]\b|\bSFr\b|\bFr\.(?= ?\d)/g;
const PAYMENT_MARKER = /zahlung|zahlbetrag|\bzahlen|gezahlt|bezahlt|überw|ueberw|gutschrift|gutgeschrieben|ausgleich|beglichen|begleichen|skonto|payment|remittance|\bpaid\b|remitted|auszahlung|credited|credit advice|incoming payment|check no|check date|check amount|cheque|pay to the order/i;
// payment words of other languages: they count only together with a payer statement ("nous avons réglé"), because
// foreign bank statements, payslips and bills use them too
const FOREIGN_PAYMENT_MARKER = /betaling|betaald|overgemaakt|paiement|règlement|reglement|réglé|virement|payé|pagamento|bonifico|pagato|\bpago\b|pagado|transferencia|transferência|płatnoś|przelew|zapłac|wpłat|plat[be]|úhrad|uhrazen|zaplacen|betalt|betalning|overført|överför/i;
// non-payment documents named anywhere in the text (when no advice title is found)
const NON_PAYMENT_MARKER = /lieferschein|lieferavis|versandavis|versandanzeige|avisierung|anlieferung|despatch advice|dispatch advice|delivery note|lastschrift|mandatsreferenz|pre-?notification|einziehen|zahlungserinnerung|\bmahnung|angebotssumme|von ihrem konto[^.]{0,40}(?:abgebucht|eingezogen)|(?:debited|collected) from your (?:bank )?account/i;
// title of a payment advice: the document checks below trust it (a title in another language only together with a
// payment statement: "avviso di pagamento" / "aviso de pago" are also bills)
const DE_EN_AVIS_TITLE = /zahlungsavis|payment advice|remittance advice|zahlungsmitteilung|erstattungsmitteilung|gutschriftsanzeige|zahlungsfreigabe|auszahlungsmitteilung|auszahlungsanzeige|regulierungsmitteilung|regulierungsschreiben|schadenregulierung|schadenabrechnung|entschädigungsabrechnung|überweisungsavis|ueberweisungsavis|zahlungsbenachrichtigung|zahlungsanzeige|vergütungsanzeige|verguetungsanzeige|payment notification/i;
const AVIS_TITLE = /zahlungsavis|payment advice|remittance advice|zahlungsmitteilung|erstattungsmitteilung|gutschriftsanzeige|zahlungsfreigabe|auszahlungsmitteilung|auszahlungsanzeige|regulierungsmitteilung|regulierungsschreiben|schadenregulierung|schadenabrechnung|entschädigungsabrechnung|überweisungsavis|ueberweisungsavis|zahlungsbenachrichtigung|zahlungsanzeige|vergütungsanzeige|verguetungsanzeige|payment notification|avis de (?:paiement|virement|règlement|reglement)|betalingsadvies|betalingsbericht|avviso di (?:pagamento|bonifico)|aviso de (?:pago|transferencia|pagamento)|awizo (?:płatności|przelewu|zapłaty)|potwierdzenie (?:płatności|przelewu)|avízo o platbě|platební avízo|oznámení o (?:platbě|úhradě)|betalingsadvis|betalingsavis|betalningsavi/i;
// title of a bank transfer form (order confirmation of the payer's bank, "Avis zur SEPA-Überweisung")
const TRANSFER_TITLE = /überweisung|ueberweisung|ausführungsbestätigung|zahlungsauftrag|payment order|wire transfer|transfer confirmation|credit transfer|virement|bonifico|transferencia|przelew|převod/i;
const TRANSFER_FIELD = /^(?:betrag|überweisungsbetrag|ueberweisungsbetrag|auftragsbetrag|amount|transfer amount|montant|importo|importe|kwota|částka)\s*(?:\(?(?:eur|chf|usd|gbp|€)\)?)?\s*:?\s*(?:eur|chf|usd|gbp|€)?\s*$/i;
// fields of a bank posting (two of them make a "Gutschrift" a bank credit, not a supplier credit note)
const BANK_FIELD = /buchungstag|buchungsdatum|valuta|wertstellung|auftraggeber|ordering customer|value date|begünstigter|beneficiary|zahlungsempfänger|\bempfänger\b|empfänger-iban|iban empfänger/gi;
// other document types in the title area (first lines of page 1, larger font)
const OTHER_TITLE = /mahnung|zahlungserinnerung|zahlungsaufforderung|letzte aufforderung|forderungsaufstellung|inkassoauftrag|inkassoforderung|mahnbescheid|vollstreckungsbescheid|zahlungsbefehl|payment reminder|reminder\b|overdue|final notice|dunning|\brappel\b|relance|herinnering|aanmaning|sollecito|recordatorio de pago|requerimiento de pago|wezwanie do zapłaty|upomnienie|upomínka|výzva k (?:úhradě|zaplacení)|rykker|påminnelse|påmindelse|stornorechnung|\bstorno\b|rechnungskorrektur|korrekturrechnung|angebot|quotation|\bquote\b|kostenvoranschlag|kostenangebot|\bofferte\b|\bdevis\b|preventivo|presupuesto|nabídka|auftragsbestätigung|auftragsbestaetigung|order confirmation|bestellbestätigung|bestätigung ihrer bestellung|purchase order|bestellschreiben|einkaufsbestellung|bon de commande|orden de compra|ordine d'acquisto|versandbestätigung|versandmitteilung|shipping confirmation|shipment notification|ist unterwegs|wurde versandt|has (?:been )?shipped|lieferschein|lieferavis|versandavis|delivery note|packing list|packliste|arrival notice|notice of arrival|ankunftsmeldung|ankunftsavis|avis d'arrivée|container arrival|bill of lading|frachtbrief|verzollungsavis|zollavis|zollanmeldung|abgabenmitteilung|einfuhrabgaben|zollbescheid|customs (?:clearance|entry|notice|invoice)|import duty|pro-?forma|abschlagsrechnung|teilrechnung|schlussrechnung|vorauszahlungsrechnung|anzahlungsrechnung|gehaltsabrechnung|entgeltabrechnung|lohnabrechnung|verdienstabrechnung|bezügemitteilung|bezügeabrechnung|brutto[/-]netto|lohn- und gehalt|payslip|pay slip|salary (?:statement|slip)|earnings statement|reisekostenabrechnung|reisekosten|spesenabrechnung|travel expense|expense (?:report|claim)|kontoauszug|account statement|bank statement|statement of account|saldenbestätigung|saldenabstimmung|saldenmitteilung|(?:kreditkarten|firmenkarten)abrechnung|abrechnung ihrer (?:firmen)?kreditkarte|ihrer firmenkreditkarte|credit card statement|preisliste|price list|allgemeine (?:geschäfts|verkaufs|liefer|einkaufs)|geschäftsbedingungen|terms and conditions|abholavis|benachrichtigungskarte|nachnahme|zahlungsplan|abschlagsplan|tilgungsplan|ratenplan|lastschrift|vorabankündigung|pre-?notification|rückgabe|rücküberweisung|rückbuchung|zurückgegeben|nicht ausgeführt|abgelehnt|returned|rejected|überweisungsträger|überweisungsvordruck|zahlschein|einzahlungsschein|zahlteil|empfangsschein|payment slip|relevé de compte|relevé bancaire|estratto conto|extracto de cuenta|extracto bancario|rekeningafschrift|bankafschrift|wyciąg bankowy|wyciąg z rachunku|výpis z účtu|bankovní výpis|kontoudtog|kontoutdrag|bulletin de (?:paie|salaire)|fiche de paie|cedolino|busta paga|\bnómina\b|loonstrook|salarisstrook|mise en demeure|ingebrekestelling|pagopa|avis d'échéance|avis de prélèvement/i;
// a title word right after one of these refers to another document ("Zahlung zu Ihrer Schlussrechnung")
const REF_BEFORE = /(?:\b(?:ihre?[rsmn]?|unsere?[rsmn]?|zu[rm]?|gem(?:äß|\.)|gemaess|lt\.?|laut|bezug|betreff|betr\.?|für|your|our|re|regarding|per|ref\.?)|(?:zahlung|ausgleich|begleichung|überweisung|regulierung|auszahlung|payment|settlement)(?:\s+(?:zu[rm]?|für|auf|der|des|von|of|for))?)(?:\s*\d{1,2}\.)?[\s:]*$/i;
// documents a payer cites as the reference of a payment ("Lieferschein-Nr.", subject "Lieferschein 80012345"):
// outside a stand-alone title they do not make the document another type when the payer states the payment
const REF_DOC = /^(?:lieferschein|delivery note|auftragsbestätigung|auftragsbestaetigung|order confirmation|abschlagsrechnung|teilrechnung|schlussrechnung)$/i;
const DELIVERY_REF = /lieferschein|delivery note/gi;
const ORDER_CONFIRM = /auftragsbestätigung|auftragsbestaetigung|order confirmation/i;
// invoice or credit note as the title line ("RECHNUNG", "Fattura n. 118/2026", "Gutschrift Nr. GS-4711")
const ORDER_START = /^(?:bestellung|einkaufsbestellung|purchase order|order|bon de commande|commande|bestelling|inkooporder|ordine|pedido|orden de compra|zamówienie|objednávka|bestilling|indkøbsordre|beställning|inköpsorder)(?![a-zà-ž])/i;
const INVOICE_START = /^(?:rechnung|rechnungskopie|invoice|tax invoice|faktura|facture|factuur|fattura|factura|fatura|duplikat|duplicate)(?![a-zà-ž])/i;
// amount-due labels of invoices ("Net à payer", "Totale da pagare", "Amount due")
const DUE_LABEL = /zu zahlen|zahlbar|amount due|balance due|total due|à payer|a payer|te betalen|da pagare|a pagar|do zapłaty|k úhradě|k zaplacení|at betale|att betala/i;
const CREDIT_TITLE = /^(?:gutschrift|lieferantengutschrift|gutschriftsrechnung|credit note|credit memo|creditnota|avoir|nota di credito|nota de crédito|dobropis|kreditnota|faktura korygująca)(?:(?:\s*-?\s*(?:nr\.?|no\.?|n°|nummer|number|#)|\s*:)?\s*(?=[\w\/.-]*\d)[A-Z0-9][\w\/.-]*)?$/i;
// credit notes listed in their own block ("Gutschriften", "Gutschrift GS-0007 238,00")
const CREDIT_WORD = /gutschrift(?!sbetrag|sanzeige| auf| aus| erfolgt| sollte| wird)|credit note|credit memo|creditnota|\bavoir\b|nota di credito|nota de crédito|dobropis|kreditnota/i;
const CREDIT_SECTION = /^\s*(?:ihre |unsere |abzgl\.? |abzüglich |\.\/\. )?(?:gutschriften|gutschrift|credit notes?|credit memos?|creditnota'?s?|avoirs?|note di credito|notas de crédito)\s*:?\s*$/i;
// the document naming itself ("Rückfragen zu diesem Zahlungsavis", "queries regarding this remittance advice"): removed
// before REQUEST_ADVICE is tested
const SELF_ADVICE = /\b(?:dies(?:e[mnrs]?)?|this|our|unser(?:e[mnrs]?)?)\s+(?:zahlungsavis|avis|remittance(?:\s+advice)?|payment advice)\b/gi;
// the writer asks for a payment advice (dunning letter, reply of the payee): never an advice itself
const REQUEST_ADVICE = /(?:senden|schicken|übermitteln|übersenden|mailen|faxen|reichen) sie (?:uns )?(?:bitte )?(?![^.]{0,60}(?:rückfrage|reklamation|einwänd|einwand|einspruch|unstimmigkeit|abweichung|beanstandung))[^.]{0,60}(?:zahlungsavis|zahlungsnachweis|überweisungsbeleg|überweisungsnachweis)|(?:zahlungsavis|\bavis) (?:fehlt|liegt (?:uns )?nicht vor)|kein(?:e|en)? (?:zahlungsavis|\bavis\b)(?![^.]{0,40}(?:wollen|möchten|mehr\b))[^.]{0,30}(?:vor\b|erhalten)|(?:please|kindly) (?:send|provide|forward|e-?mail)(?: us)?(?![^.]{0,60}(?:quer|question|enquir|inquir))[^.]{0,60}(?:remittance|payment advice|proof of payment)|remittance advice (?:is )?missing|zahlungsavise? bitte (?:an|per|via)\s|veuillez (?:nous )?(?:envoyer|transmettre|faire parvenir)[^.]{0,60}avis|bitte um (?:(?:zusendung|übersendung|übermittlung|nachreichung) )?(?:(?:ein|eine[ns]?|das|des) )?(?:zahlungsavis|\bavis\b|zahlungsnachweis)|bitte[n]?(?: sie| wir)?(?: sie)? um (?:die )?(?:zusendung|übersendung|übermittlung|nachreichung) (?:(?:eines?|einer|des|der|ihres|ihrer|das|ein) )?(?:[a-zäöüß]+e[nrsm]? )?(?:zahlungsavis|\bavis\b|zahlungsnachweis|überweisungsbeleg)|anforderung (?:eines |des |von )?(?:zahlungsavis|\bavis\b)|(?:zahlungsavis|\bavis\b)[^.]{0,40}\bweder\b[^.]{0,60}\bnoch\b[^.]{0,40}erhalten|request(?:ing)? (?:for )?(?:a |an |the |your )?(?:remittance|payment advice)|(?:have )?not (?:yet )?received (?:a |any |the |your )?(?:remittance|payment advice)|(?:zahlungsavis|\bavis\b) (?:angefordert|erbeten)|(?:but|without) (?:no |a |any )?(?:remittance|payment) advice/i;
// the other party's request named by the payer ("Ihrer Bitte um Zusendung des Zahlungsavis kommen wir nach", "further to
// your request for remittance advice") and conditionals ("if you have not received the remittance"): removed before
// REQUEST_ADVICE is tested; the gap must not hold a request of its own ("zu Ihrer Anfrage, bitte senden Sie uns das
// Zahlungsavis", "your request, please send us the remittance advice")
const REQUEST_REF = /\b(?:ihre[rmns]?|your)\s+(?:bitte|anforderung|anfrage|request)\b(?:(?!please|kindly|bitte|\bsend|schick|übermitt|maile)[^.\n]){0,30}?(?:zahlungsavis|\bavis\b|remittance|payment advice)|\b(?:if|in case|should)\s+(?:you\s+)?(?:have\s+|do\s+)?not\s+(?:yet\s+)?received?\b/gi;
// a forwarded mail's subject ("WG: Bitte um Zahlungsavis") is not the writer's own request
const FORWARD_PREFIX = /^\s*(?:wg|fw|fwd|wtr|tr)\s*:/i;
// text for the request / payee tests: dots inside numbers and dates ("06.11.2026", "1.234,00") and after common
// abbreviations ("ggf.", "bzw.", "z. B.") removed, so that [^.] gaps run across them
const ABBREV_PAIR = /\b([zudo])\. ?([bahä])\./gi;
const ABBREV_DOT = /\b(ggf|bzw|evtl|vgl|inkl|zzgl|ca|nr|bspw|usw|etc|tel|str|abs|ziff|bzgl|gem|lt|hr|fr|dr)\./gi;
// the writer received the money (payee's letter about a payment: "auf unserem Konto ... eingegangen", "können wir keiner
// Rechnung zuordnen", "we are unable to match it"): not an advice, unless an advice title says otherwise; only the
// writer itself ("we") cannot allocate it ("If you cannot allocate this payment, please contact us" is the payer's footer)
const PAYEE_VIEW = /auf unser(?:em|e)? (?:bank)?konto[^.]{0,80}(?:eingegangen|gutgeschrieben worden)|(?:zahlung|betrag|überweisung)[^.\n]{0,60}bei uns[^.]{0,40}eingegangen|bei uns[^.]{0,20}(?:zahlung|betrag|überweisung)[^.]{0,40}eingegangen|zahlungseingang[^.]{0,80}(?:nicht|keine[mnr]?)[^.]{0,30}zu(?:zu)?ordnen|(?:zahlung|betrag|überweisung)[^.\n]{0,60}(?:können|konnten) wir[^.]{0,40}(?:nicht|keine[mnr]?)[^.]{0,40}zu(?:zu)?ordnen|nicht zu(?:zu)?ordnen(?:de[nr]?)? (?:zahlung|betrag)|nicht zuordenbare[nr]? (?:zahlung|betrag)|(?:received|receipt of) (?:a |your )?payment[^.]{0,80}(?:cannot|could not|unable to) (?:allocate|match|identify|assign)|unallocated (?:payment|receipt|cash)|unidentified (?:payment|receipt)|\bwe(?: are| were| have been| had been)? (?:unable to|cannot|can't|can not|could not|couldn't) (?:allocate|match|identify|assign) (?:it|this payment|the payment|your payment|this amount|the amount)\b/i;
// a sentence about a refund the writer received ("Ihre Rückzahlung über 120,00 EUR ist auf unserem Konto eingegangen"):
// the payer's view, not the payee's
const REFUND_WORD = /^\s*(?:ihre |die |der |your |the )?(?:rückzahlung|rückerstattung|erstattung|gutschrift|refund|credit note)/i;
// open items of the payee's ledger ("Summe offene Posten", "Saldo offene Posten", "open items"): an open amount, never the
// payment; OPEN_SETTLED: "Ausgleich offener Posten" in an advice is the payment
const OPEN_ITEMS = /offene[nr]? posten|\bop-?(?:liste|saldo)\b|open items|outstanding items/i;
const OPEN_SETTLED = /ausgleich|ausgegl|begleich|beglichen|bezahlt|gezahlt|zahlung|zahlbetrag|überw|ueberw|paid|payment|remit|settle/i;
// reference fields and phrases: the document named after them is the other party's document ("Ihr Zeichen: Mahnung vom
// 06.10.2026", "bezugnehmend auf Ihre Mahnung"), not this document's title
const REF_FIELD = /^(?:(?:ihr(?:e)?|unser(?:e)?)\s+(?:zeichen|nachricht|schreiben|e-?mail|mail|anfrage|referenz|ref\.?|auftrag|bestellung|bestell-?nr\.?)(?:\s+vom)?|bezug|bezugnehmend auf|betreffend|bezüglich|your (?:ref(?:erence)?|letter|message)|our ref(?:erence)?|reference)(?![a-zäöüß])\s*:?\s*/i;
const REF_STRONG = /^(?:(?:ihr(?:e)?|unser(?:e)?)\s+(?:zeichen|nachricht|schreiben)|bezug\b|bezugnehmend auf|betreffend|bezüglich|your ref|our ref)/i;
const REF_PHRASE = /\b(?:ihre?[rsmn]?|bezugnehmend auf|bezüglich|betreffend|mit bezug auf|in bezug auf|your)\s+(?:(?:\d+\.|erste[nr]?|zweite[nr]?|letzte[nr]?)\s+)?(?:mahnung|zahlungserinnerung|erinnerung|payment reminder|reminder)/gi;
// recipient address and department lines ("Personalabteilung / Entgeltabrechnung", "z. Hd. Lohnbuchhaltung") name a
// department, not the document; ZIP_CITY ends an address block
const DEPT_WORD = /abteilung|\babt\.|z\.\s?hd\.?|zu händen|\battn\.?|\bc\/o\b|department|\bdept\.?|\breferat\b|fachbereich|sachgebiet/i;
const ZIP_CITY = /^(?:[A-Z]{1,2}-)?\d{4,5}\s+[A-ZÄÖÜ][a-zäöüß]/;
// the writer wants to be paid (dunning letters, invoices, claims)
const DEMAND = /bitte (?:überweisen|zahlen|begleichen|bezahlen) sie|(?:überweisen|zahlen|begleichen|bezahlen) sie (?:bitte|den|diesen|die)\b|bitte gleichen sie (?:den|diesen|einen|die summe|die forderung)\b(?![^.]{0,60}(?:buchhaltung|büchern|offenen posten))|bitte um (?:überweisung|zahlung|begleichung|ausgleich)|wir bitten (?:sie )?um (?:begleichung|ausgleich|überweisung|zahlung|umgehende)|fordern (?:wir )?sie[^.]{0,40}auf|(?:please|kindly) (?:pay|remit|settle|transfer|arrange payment)\b|payment is due|veuillez (?:régler|payer|virer)|gelieve[^.]{0,30}(?:te betalen|over te maken)|si prega di (?:pagare|saldare|effettuare il pagamento)|(?:le )?rogamos (?:abone|abonen|pague|paguen)|prosimy o (?:zapłatę|uregulowanie|wpłatę|przelew)|prosíme o (?:úhradu|zaplacení)|venligst betal|vänligen betala|(?:wir bitten|bitten wir|ich bitte|bitte ich) sie(?:[^.]|\.(?=\d)){0,80}\bzu (?:überweisen|zahlen|bezahlen|begleichen)/i;
const DUNNING = /sollten sie (?:die|den|diese|diesen)? ?(?:zahlung|betrag|rechnung|forderung|gesamtbetrag|rechnungsbetrag)[^.]{0,60}(?:bereits|zwischenzeitlich|inzwischen)|(?:if|in case) you have already (?:paid|made|sent|settled|remitted)|keinen zahlungseingang|letzte (?:zahlungs)?aufforderung|\bin verzug\b/i;
// the document says no money is transferred (credit note to be offset, cancellation)
const NO_PAYMENT = /(?:auszahlung|überweisung|zahlung)(?: oder überweisung)? (?:erfolgt|ist) nicht|eine zahlung ist nicht erforderlich|keine (?:auszahlung|zahlung) erforderlich|no payment (?:is )?(?:required|will be made)|will be (?:offset|deducted) (?:against|from) (?:your )?(?:next|future)|mit (?:ihrer|der) nächsten rechnung verrechnet/i;
// payroll / travel expense / shipping vocabulary (two or three of them make the document type)
const PAYROLL_WORD = /lohnsteuer|sozialversicherung|rentenversicherung|krankenversicherung|steuerklasse|kirchensteuer|solidaritätszuschlag|gesetzliche abzüge|personalnummer|national insurance|income tax|gross pay|net pay/gi;
const EXPENSE_WORD = /verpflegungsmehraufwand|kilometerpauschale|übernachtung|reisezweck|reiseziel|dienstreise|per diem|mileage|reiseantritt/gi;
const SHIPPING_WORD = /\bvessel\b|\bvoyage\b|\beta\b|container|b\/l\b|port of (?:loading|discharge)|demurrage|terminal handling|freight|schiff|reederei|löschhafen/gi;
// payer's statement of a payment ("wir haben ... überwiesen", "we have paid")
const PAYER_STATEMENT = /(?:wir haben|haben wir|wurde|wurden|wird|werden)[^.]{0,80}(?:überwiesen|ueberwiesen|angewiesen|bezahlt|beglichen|ausgeglichen|gutgeschrieben)|(?:überweisen|zahlen|begleichen) wir|anbei (?:erhalten sie )?(?:die|unsere) zahlung|zahlung (?:für|zu) (?:ihre[rn]? )?rechnung|we have (?:today )?(?:paid|transferred|remitted|released|made|settled)|has been (?:paid|transferred|remitted|settled)|payment (?:has been|was) (?:made|sent|released|initiated)|nous avons (?:réglé|payé|viré|effectué)|wij hebben[^.]{0,40}(?:betaald|overgemaakt)|abbiamo[^.]{0,40}(?:pagato|bonificato|effettuato)|hemos[^.]{0,40}(?:pagado|transferido|realizado)|(?:jsme|uhradili|zaplatili)[^.]{0,40}(?:uhradili|zaplatili|převedli|jsme)|(?:przelaliśmy|zapłaciliśmy|uregulowaliśmy|dokonaliśmy)|vi har[^.]{0,40}(?:betalt|overført|betalat|överfört)|(?:efetu[aá]mos|pagámos|transferimos)/i;
// first-person statement of a completed payment ("wir haben ... überwiesen", also across "1.204,00"); invoices and
// orders say "wird ... bezahlt"
const PAYER_DONE = /(?:wir haben|haben wir)(?:[^.]|\.(?=\d)){0,80}(?:überwiesen|ueberwiesen|angewiesen|bezahlt|beglichen|ausgeglichen)|we have (?:today )?(?:paid|transferred|remitted|settled)/i;
// an open amount or a direct debit next to a foreign advice title ("Aviso de pago pendiente", pagoPA "Avviso di
// pagamento", "hemos realizado el cargo en su cuenta")
const FOREIGN_OPEN = /pendiente|pendente|in sospeso|data limite|fecha límite|date limite|pagopa|codice avviso|prélèvement|domiciliación|domiciliazione|addebito|\bcargo\b|adeudo|\bincasso\b|obciążen|inkas|débito|si ya ha pagado|già pagato|déjà (?:payé|réglé)|\breeds betaald|\bal betaald/i;
// sentences of the writer: first person, payment verb, an earlier payment ("haben wir bereits am 01.10.2026 überwiesen")
// and the current one ("heute überweisen wir den Restbetrag")
const FIRST_PERSON = /\b(?:wir|we|ich)\b/i;
const SENT_PAY = /überwiesen|ueberwiesen|überweisen|ueberweisen|angewiesen|bezahlt|gezahlt|beglichen|begleichen|ausgeglichen|geleistet|transferred|transferring|remitted|paid\b|settled/i;
const PRIOR_SENT = /\b(?:bereits|schon|zuvor|already|previously|earlier)\b[^.]{0,60}(?:überwiesen|ueberwiesen|angewiesen|bezahlt|gezahlt|beglichen|ausgeglichen|geleistet|paid|transferred|remitted|settled)|(?:überwiesen|ueberwiesen|bezahlt|gezahlt|beglichen|paid|transferred)\b[^.]{0,20}\b(?:bereits|schon|zuvor|already|previously|earlier)\b/i;
const CURRENT_WORD = /\b(?:heute|hiermit|nunmehr|today|herewith)\b|mit (?:dieser|der heutigen) (?:zahlung|überweisung)|restbetrag|restzahlung|schlusszahlung|schlussrate|letzte rate|verbleibende[nr]? (?:rest)?betrag|remaining (?:balance|amount)|final (?:instal|payment)/i;
const REST_WORD = /restbetrag|restzahlung|verbleibende[nr]? (?:rest)?betrag|remaining (?:balance|amount)/i;
// a payment announced for later ("überweisen wir nach Klärung", "werden wir am 15.11.2026 überweisen", "next week")
const FUTURE_SENT = /\b(?:werden|wird|will|shall)\b|nächste|naechste|kommende|künftig|später|sobald|\bnach (?:klärung|eingang|prüfung|erhalt|abschluss)|\bnext\b|\blater\b|\bonce\b|\bupon\b/i;
// "bereits / zuvor / earlier" that belongs to a reference to earlier talks, not to the payment ("wie zuvor telefonisch
// besprochen", "wie bereits mitgeteilt", "as advised in our earlier e-mail")
const PRIOR_ASIDE = /\b(?:wie|as)\s+(?:[a-zäöüß-]+\s+){0,4}?(?:mitgeteilt|besprochen|vereinbart|angekündigt|avisiert|informiert|advised|mentioned|discussed|agreed|notified|informed|stated|indicated)\b|\b(?:in|per|with|mit|laut|lt)\s+(?:our\s+|unserer?\s+|unserem\s+|the\s+|der\s+|dem\s+)?(?:earlier|previous|vorherigen|früheren|letzten)\s+(?:e-?mail|mail|letter|schreiben|nachricht|telefonat)/gi;
// "Das sind 1.166,20 EUR": a short sentence that refers back to the payment of the sentence before
const ANAPHOR = /^\s*(?:das|dies|es|er|this|that|it)\s+(?:sind|ist|macht|machen|ergibt|ergeben|beträgt|betragen|is|are|amounts? to|comes? to|makes?)\b/i;
// netting words anywhere in the text: a single amount is then not trusted blindly
const NETTING_TEXT = /skonto|abzug|abzgl|abzüglich|einbehalt|kürzung|gekürzt|minderung|verrechn|aufrechn|teilzahlung|teilbetrag|\brate\b|raten|restbetrag|differenz|discount|deduct|withh|partial|instal|\bless\b|korting|escompte|sconto|descuento|delkredere|bonus/i;
const SALUTATION = /^\s*(?:sehr geehrte|liebe[rs]? |hallo\b|guten tag|grüß gott|dear\b|hello\b|hi\b|geachte|beste\b|madame|monsieur|messieurs|gentile|egregi|estimad|prezad|szanown|vážen|dobrý den|kære|hej\b|bonjour|buongiorno)/i;
const MAIL_HEADER = /^\s*(?:von|from|an|to|cc|gesendet|sent|datum|date|betreff|subject|objet|onderwerp|oggetto|asunto|temat|předmět|emne|ämne)\s*:/i;
const MAIL_FROM = /^\s*(?:von|from|de|van|da|od|fra|från)\s*:/i;
const MAIL_SUBJECT = /^\s*(?:betreff|subject|objet|onderwerp|oggetto|asunto|temat|předmět|emne|ämne)\s*:\s*/i;
const REPLY_PREFIX = /^\s*(?:aw|re|antw|antwort|sv|vs|odp|r)\s*:/i;
const QUOTE_MARK = /^\s*(?:-{2,}\s*(?:original|ursprüngliche|weitergeleitete|forwarded|message transféré|mensaje original)|(?:am|on|le|el|il|op|dne|den)\s.{4,120}(?:schrieb|wrote|a écrit|escribió|ha scritto|schreef|napsal|skrev)\s*:?\s*$|>\s?\S)/i;
// reference to an invoice or credit note in a label (an itemised line)
const ITEM_REF = /rechnung|invoice|faktur|factur|fattura|factuur|beleg|gutschrift|credit|\bre[- .]?\d|\brg\.?\s?\d/i;
const PAY_START = /^\s*(?:zahlung|überweisung|ueberweisung|auszahlung|payment|betaling|paiement|virement|pagamento|bonifico|pago|transferencia|platba|płatność|przelew|betalning)\b/i;
const PAY_NOUN = /^(?:zahlung|überweisung|ueberweisung|auszahlung|payment|betaling|paiement|virement|pagamento|bonifico|pago|transferencia|platba|płatność|przelew|betalning)\s*:?\s*(?:eur|chf|usd|€)?\s*$/i;
const TOTAL_WORD = /gesamt|summe|total|insgesamt|totaal|celkem|totale/i;
const FUTURE_WORD = /nächste|naechste|kommende|künftig|voraussichtlich|geplant|\bnext\b|future|planned|scheduled/i;
const INVOICE_HEAD = /^\s*(?:rechnung|rechnungskopie|kopie der rechnung|invoice|faktura)\b/i;
const VAT_LINE = /zzgl|mwst|(?:^|[^a-zäöüß])ust(?![a-zäöüß])|umsatzsteuer|mehrwertsteuer|(?:^|[^a-z])(?:vat|tva|btw|iva|dph|moms|mva)(?![a-z])/i;
const GROUP_MARK = "\u0001";

function sentenceEnd(s: string, from: number): number {
  // Index right after the first sentence end at or after from ("... überwiesen. Heute ..."), or -1. Dots inside numbers
  // and dates and after common abbreviations ("Nr.", "z. B.", "ggf.") do not end a sentence.
  const re = /[.!?]\s+(?=[A-ZÄÖÜ])/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) !== null && guard < 200) {
    guard++;
    const before = s.substring(Math.max(0, m.index - 6), m.index);
    if (/(?:^|[^A-Za-zÄÖÜäöüß])(?:nr|ca|bzw|ggf|vgl|inkl|zzgl|evtl|str|tel|dr|hr|fr|abs|ziff|gem|lt|bzgl|[A-Za-z])$/i.test(before)) continue;
    return m.index + m[0].length;
  }
  return -1;
}

function lastSentenceStart(s: string): number {
  // Index after the last sentence end in s (0 if there is none).
  let k = 0;
  let e = sentenceEnd(s, 0);
  let guard = 0;
  while (e >= 0 && guard < 200) { guard++; k = e; e = sentenceEnd(s, e); }
  return k;
}

function normalizeLine(line: string): string {
  // Normalizes one text line: Unicode spaces/ligatures (NFKC), group separators, split amounts, letter spacing.
  // group separators between digits (no-break, thin, narrow, figure spaces, apostrophes) – before NFKC turns them into spaces
  let s = line.replace(/(\d)[\u00A0\u2007\u2008\u2009\u200A\u202F'\u2019\u02BC\u00B4`](?=\d{3}(?!\d))/g, "$1" + GROUP_MARK);
  s = s.normalize("NFKC").replace(/\u2212/g, "-").replace(/\t/g, " ");
  if (s.indexOf(GROUP_MARK) >= 0) {
    const reG = /\d+(?:\u0001\d{3})+([.,]\d{2}(?!\d))?/g;
    let out = "", last = 0;
    let m: RegExpExecArray | null;
    while ((m = reG.exec(s)) !== null) {
      const dec = m[1] ? m[1].charAt(0) : "";
      out += s.substring(last, m.index) + m[0].split(GROUP_MARK).join(dec === "," ? "." : dec === "." ? "," : "");
      last = m.index + m[0].length;
    }
    s = (out + s.substring(last)).split(GROUP_MARK).join(" ");
  }
  // "3 . 454 , 00" / "4. 271. 610, 12" -> one German amount; "3 , 454 . 00" -> one English amount
  s = glueSpaced(s, /\d{1,3}(?: ?\. ?\d{3})+ ?, ?\d{2}(?!\d)/g);
  s = glueSpaced(s, /\d{1,3}(?: ?, ?\d{3})+ ?\. ?\d{2}(?!\d)/g);
  // "1234 , 00" (not a date tail like "4711, 15.09.2026")
  s = s.replace(/(\d) ?, ?(\d{2})(?!\d|[.,]\d)/g, "$1,$2");
  // space-grouped thousands "3 454,00" / "1 234 567,89" – never glue "Nr. 816 120,00"
  if (/\d \d{3}[.,]\d{2}/.test(s)) {
    const reS = /\d{1,3}(?: \d{3})+(?=[.,]\d{2}(?!\d))/g;
    let out = "", last = 0;
    let m: RegExpExecArray | null;
    while ((m = reS.exec(s)) !== null) {
      const before = m.index > 0 ? s.charAt(m.index - 1) : " ";
      if (/[\d.,]/.test(before) || NUMBER_LABEL_BEFORE.test(s.substring(Math.max(0, m.index - 14), m.index))) continue;
      const dec = s.charAt(m.index + m[0].length);
      out += s.substring(last, m.index) + m[0].split(" ").join(dec === "," ? "." : ",");
      last = m.index + m[0].length;
    }
    s = out + s.substring(last);
  }
  // whole-unit notation "1.500,-- EUR"
  s = s.replace(/(\d),(?:--|-|\u2013|\u2014)(?![\d-])/g, "$1,00");
  // letter-spaced labels "Ü B E R W E I S U N G S B E T R A G" -> one word
  if (/(?:[A-Za-zÄÖÜäöüß] ){3}/.test(s)) {
    const reL = /(?:[A-Za-zÄÖÜäöüß] ){3,}[A-Za-zÄÖÜäöüß](?![A-Za-zÄÖÜäöüß0-9])/g;
    let out = "", last = 0;
    let m: RegExpExecArray | null;
    while ((m = reL.exec(s)) !== null) {
      if (m.index > 0 && /[A-Za-zÄÖÜäöüß0-9]/.test(s.charAt(m.index - 1))) continue;
      out += s.substring(last, m.index) + m[0].split(" ").join("");
      last = m.index + m[0].length;
    }
    s = out + s.substring(last);
  }
  return s;
}

function glueSpaced(s: string, re: RegExp): string {
  // Removes single spaces inside matches of re that start at a number boundary.
  if (s.indexOf(" ") < 0) return s;
  let out = "", last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].indexOf(" ") < 0) continue;
    const before = m.index > 0 ? s.charAt(m.index - 1) : " ";
    if (/[\d.,]/.test(before)) continue;
    out += s.substring(last, m.index) + m[0].split(" ").join("");
    last = m.index + m[0].length;
  }
  return out + s.substring(last);
}

function parseGermanAmount(a: string): number {
  let s = a.replace(/\s/g, "");
  let neg = false;
  if (s.startsWith("-")) { neg = true; s = s.substring(1); }
  if (s.endsWith("-")) { neg = true; s = s.substring(0, s.length - 1); }
  s = s.replace(/\./g, "").replace(",", ".");
  const v = parseFloat(s);
  return neg ? -v : v;
}

function parseEnglishAmount(a: string): number {
  let s = a.replace(/\s/g, "");
  let neg = false;
  if (s.startsWith("-")) { neg = true; s = s.substring(1); }
  if (s.endsWith("-")) { neg = true; s = s.substring(0, s.length - 1); }
  s = s.replace(/,/g, "");
  const v = parseFloat(s);
  return neg ? -v : v;
}

function detectEnglishFormat(lines: string[]): boolean {
  // Number format of the whole document from unambiguous matches (dates and times removed first).
  let de = 0, en = 0;
  for (const ln of lines) {
    if (!/\d[.,]\d/.test(ln)) continue;
    const t = ln.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
    de += 3 * (t.match(/\d\.\d{3},\d{2}(?!\d)/g) || []).length + (t.match(/\d,\d{2}(?![\d.,])/g) || []).length;
    en += 3 * (t.match(/\d,\d{3}\.\d{2}(?!\d)/g) || []).length + (t.match(/\d\.\d{2}(?![\d.,])/g) || []).length;
  }
  return en > de;
}

function findAmountsInLine(line: string, english: boolean): AmountMatch[] {
  const out: AmountMatch[] = [];
  const re = english
    ? /-?\d{1,3}(?:,\d{3})+\.\d{2}-?|-?\d+\.\d{2}-?/g
    : /-?\d{1,3}(?:\.\d{3})+,\d{2}-?|-?\d+,\d{2}-?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index, end = start + m[0].length;
    const before = start > 0 ? line.charAt(start - 1) : " ";
    const after = end < line.length ? line.charAt(end) : " ";
    const after2 = end + 1 < line.length ? line.charAt(end + 1) : " ";
    if (/[\d.,]/.test(before) || /\d/.test(after)) continue;
    // garbled number "3.4S4,00" / "1.2O0,00": do not read the tail as an amount
    if (/[A-Za-z]/.test(before) && start > 1 && /[\d.,]/.test(line.charAt(start - 2))) continue;
    if ((after === "." || after === ",") && /\d/.test(after2)) continue; // date tail "05.10.2026", "3.454.00"
    const unit = line.substring(end, end + 12);
    // 24,80 kg / 500,00 ST / 2,00 % / 8,00 h; in English "to" is the preposition ("EUR 3,120.00 to your account"), not tonnes
    if ((UNIT_AFTER.test(unit) && !(english && /^\s?to(?![A-Za-z])/i.test(unit))) || UNIT_AFTER_H.test(unit)) continue;
    let value = english ? parseEnglishAmount(m[0]) : parseGermanAmount(m[0]);
    if (isNaN(value) || !isFinite(value)) continue;
    if (value > 0 && before === "(" && after === ")") value = -value;     // accounting "(120,00)"
    else if (value > 0 && /^ -(?:\s{2,}|\s*$)/.test(line.substring(end, end + 4))) value = -value; // "120,00 -"
    out.push({ text: m[0].replace(/\s/g, ""), value: value, index: start, end: end });
  }
  return out;
}

function segmentLabel(seg: string, extra: RegExp | null, afterAmount: boolean): LabelInfo {
  // Keyword classes of a label segment. afterAmount: the segment follows another amount on the same line.
  let s = seg;
  if (afterAmount) {
    // "3.454,00 EUR überwiesen (Skonto 70,49 EUR)": the verb belongs to the previous amount
    const pm = PAYMENT_KEYWORDS.exec(s);
    if (pm) {
      const rest = s.substring(pm.index + pm[0].length);
      if (NEGATIVE_KEYWORDS.test(rest)) s = rest;
    }
  }
  const lab: LabelInfo = { strong: STRONG_KEYWORDS.test(s), payment: PAYMENT_KEYWORDS.test(s), weak: WEAK_KEYWORDS.test(s), neg: NEGATIVE_KEYWORDS.test(s), ded: DEDUCTION_KEYWORDS.test(s) };
  if (lab.payment && (YEAR_TO_DATE.test(s) || (CUMULATIVE.test(s) && !PAYMENT_LABEL.test(s)) || NOT_PAID.test(s))) { lab.payment = false; lab.neg = true; }
  // open items of the payee's ledger ("Summe offene Posten", "Saldo offene Posten") are no total of a payment
  if (OPEN_ITEMS.test(s) && !OPEN_SETTLED.test(s)) { lab.payment = false; lab.strong = false; lab.neg = true; }
  // an earlier payment in a label ("bereits gezahlt", "1. Rate (bereits überwiesen am 15.09.)") reduces the amount; not in a sentence of the payer
  if (PRIOR.test(s) && PRIOR_PAID.test(s) && !SENTENCE_VERB.test(s)) { lab.payment = false; lab.strong = false; lab.neg = true; lab.ded = true; }
  if (extra !== null && extra.test(s)) { lab.strong = true; lab.payment = true; }
  return lab;
}

function hasWords(s: string): boolean {
  const t = s.replace(CURRENCY_TOKEN, " ");
  CURRENCY_TOKEN.lastIndex = 0;
  return /[A-Za-zÄÖÜäöüß]{2,}/.test(t);
}

function headerCellClass(cell: string): string {
  // Column class of a table header cell.
  const c = cell.toLowerCase();
  if (/datum|date|fecha|\bdata\b|nr\b|nr\.|nummer|number|no\.|n°|währung|waehrung|currency|devise|kurs|text|bezeichnung|artikel|material|referenz|reference|référence|riferimento|referencia|gewicht|menge|einheit|^pos/.test(c)) return "id";
  // an earlier payment ("bereits gezahlt", "previously paid") is no payment column
  if (/bereits|already|previously|prior|bisher|déjà|reeds|già|\bya\b|již|już|allerede|redan/.test(c)) return "prev";
  if (/rest|offen|open|outstanding|balance|saldo|solde|resto|pendiente|zbývá|pozostał/.test(c)) return "rest";
  if (/skonto|abzug|discount|einbehalt|rabatt|deduction|gutschrift|delkredere|bonus|provision|gebühr|\bfees?\b|commission|aufrechn|verrechn|korting|escompte|remise|sconto|descuento|rabat|sleva|retenue|ritenuta|retención|withholding|bauabzug/.test(c)) return "ded";
  if (/ust\b|ust\.|mwst|vat\b|steuer|tax|btw|tva|\biva\b|dph/.test(c)) return "vat";
  if (/zahlbetrag|zahlungsbetrag|zahlung|gezahlt|bezahlt|überw|ueberw|auszahl|paid|payment|remit|betaald|betaling|réglé|payé|paiement|virement|pagato|pagamento|bonifico|pagado|\bpago\b|transferencia|płatno|zapłac|przelew|uhrazen|platba|úhrad|betalt|betalning/.test(c)) return "pay";
  if (/netto|\bnet\b/.test(c)) return "net";
  if (/brutto|gross|betrag|amount|summe|total|wert|value|preis|price|bedrag|montant|importo|importe|valor|kwota|částka|beløb|belopp|bruto|brut\b/.test(c)) return "gross";
  return "id";
}

function lineCells(text: string): number[] {
  // Cells of a line separated by 2+ spaces: [start, end) pairs.
  const out: number[] = [];
  const re = /\S+(?: \S+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) { out.push(m.index); out.push(m.index + m[0].length); }
  return out;
}

function mapTableColumns(infos: LineInfo[]): void {
  // Maps table rows to the amount columns of the nearest header line (Rechnungsbetrag / Skonto / Zahlbetrag ...).
  for (let h = 0; h < infos.length; h++) {
    const hd = infos[h];
    if (hd.amounts.length > 0 || hd.text.length === 0) continue;
    const cells = lineCells(hd.text);
    const n = cells.length / 2;
    if (n < 2) continue;
    // a label line ("Zahlbetrag gesamt:   Grund: Zahlungsavis" beside a signature box) is no table header
    if (/:$/.test(hd.text.substring(cells[0], cells[1]))) continue;
    const cls: string[] = [];
    const amountCols: string[] = [];
    let hasPay = false, hasDed = false, hasVat = false;
    for (let c = 0; c < n; c++) {
      const k = headerCellClass(hd.text.substring(cells[2 * c], cells[2 * c + 1]));
      cls.push(k);
      if (k === "pay") hasPay = true;
      if (k === "ded") hasDed = true;
      if (k === "vat") hasVat = true;
    }
    // header on two lines ("bereits | diese" over "gezahlt | Zahlung"): the first of two payment columns is the earlier payment
    let pays = 0;
    for (let c = 0; c < n; c++) if (cls[c] === "pay") pays++;
    if (pays >= 2 && h > 0 && infos[h - 1].amounts.length === 0 && /bereits|already|previously|bisher|prior/i.test(infos[h - 1].text)) {
      for (let c = 0; c < n; c++) if (cls[c] === "pay") { cls[c] = "prev"; break; }
    }
    for (let c = 0; c < n; c++) {
      if (cls[c] === "net") cls[c] = hasDed && !hasVat && !hasPay ? "pay" : "gross";
      if (cls[c] !== "id") amountCols.push(cls[c]);
    }
    if (amountCols.length < 2) continue;
    hd.header = true;
    const rightmost = amountCols[amountCols.length - 1];
    const rows: number[] = [];
    let dataRows = 0;
    for (let r = h + 1; r < infos.length && r <= h + 80; r++) {
      const row = infos[r];
      if (row.text.length === 0) break;
      if (row.amounts.length === 0) {
        if (lineCells(row.text).length >= 4 && /betrag|amount|skonto|summe/i.test(row.text)) break; // next header
        continue;
      }
      if (row.amounts.length < 2) continue;
      const k = row.amounts.length;
      let mapped = false;
      if (k === amountCols.length) {
        for (let j = 0; j < k; j++) row.cols[j] = amountCols[j];
        mapped = true;
      } else {
        const rc = lineCells(row.text);
        if (rc.length === cells.length) {
          for (let j = 0; j < k; j++) {
            for (let c = 0; c < n; c++) {
              if (row.amounts[j].index >= rc[2 * c] && row.amounts[j].index < rc[2 * c + 1]) { row.cols[j] = cls[c] === "id" ? "" : cls[c]; mapped = true; break; }
            }
          }
        }
      }
      if (!mapped) { if (!row.label.strong) dataRows++; continue; }
      for (let j = 0; j < k; j++) if (!row.lineLabel[j]) row.cols[j] = "";
      row.risky = rightmost === "ded" || rightmost === "rest";
      row.payCol = hasPay;
      rows.push(r);
      if (!row.label.strong) dataRows++;
    }
    for (const r of rows) infos[r].payBonus = infos[r].label.strong || dataRows === 1;
    // "Netto | USt | Brutto" with one invoice row: the gross amount is what gets paid
    if (dataRows === 1 && rightmost === "gross" && hasVat && !hasPay && !hasDed && amountCols.indexOf("rest") < 0) {
      for (const r of rows) if (!infos[r].label.strong) infos[r].grossPay = true;
    }
  }
}

function markInvoiceCopies(infos: LineInfo[]): void {
  // Marks lines of appended invoice copies (heading "Rechnung ..." followed by a VAT line with an amount).
  let avisPage = false; // a payment advice title earlier on the same page
  for (let i = 0; i < infos.length; i++) {
    if (infos[i].text.length === 0) avisPage = false;
    else if (AVIS_TITLE.test(infos[i].text)) avisPage = true;
    if (infos[i].amounts.length > 0 || infos[i].header || !INVOICE_HEAD.test(infos[i].text)) continue;
    let end = i + 1;
    let vat = false, ded = false;
    while (end < infos.length && infos[end].text.length > 0 && !(infos[end].amounts.length === 0 && INVOICE_HEAD.test(infos[end].text))) {
      const inf = infos[end];
      if (inf.amounts.length > 0 && VAT_LINE.test(inf.text)) vat = true;
      if (inf.amounts.length > 0 && inf.labels[0].ded && !inf.labels[0].payment) ded = true;
      end++;
    }
    // on the advice page itself, a block with a deduction ("abzgl. 2 % Skonto") is a per-invoice payment block, not a copy
    if (vat && !(avisPage && ded)) for (let k = i; k < end; k++) infos[k].copy = true;
    i = end - 1;
  }
}

function newCandidate(a: AmountMatch, line: string, lineIdx: number, pos: number, label: LabelInfo): Candidate {
  return { amount: a.text, value: a.value, score: 0, line: line, lineIdx: lineIdx, method: "largest", pos: pos, charIdx: a.index, label: label, lineLabel: false, ownLabel: false, confirmed: false, copy: false, risky: false, col: "" };
}

function deductionChain(all: Candidate[], infos: LineInfo[], candAt: Candidate[][], pairs: number[]): void {
  // Total T, deduction D, payment P with |T - |D| - P| < 0.015 -> prefer P, demote T. pairs receives (P, T) values.
  const ts: Candidate[] = [];
  const ps: Candidate[] = [];
  const ds: Candidate[] = [];
  for (const c of all) {
    const isDed = (c.label.ded && !c.label.payment) || c.col === "ded" || c.col === "prev";
    if (isDed) { if (c.value !== 0) ds.push(c); continue; }
    if (c.value <= 0) continue;
    if (c.label.strong && !c.label.payment && c.method !== "keyword-next-line") ts.push(c);
    if (!c.label.neg || c.label.payment) ps.push(c);
  }
  if (ds.length === 0 && ts.length === 0) return;
  if (ps.length * (ts.length + 4) > 200000 || ds.length > 2000) return;
  const payValues: number[] = [];
  const totValues: number[] = [];
  for (const p of ps) {
    const pPay = p.label.payment || p.col === "pay";
    // candidate totals: strong totals, or (for a payment line) a single amount up to 3 lines above
    const tlist: Candidate[] = [];
    for (const t of ts) tlist.push(t);
    if (pPay) {
      for (let li = Math.max(0, p.lineIdx - 3); li < p.lineIdx; li++) {
        if (candAt[li].length !== 1) continue;
        const t = candAt[li][0];
        if (!t.label.ded && !t.label.payment && !t.label.strong && t.value > 0) tlist.push(t);
      }
    }
    for (const t of tlist) {
      if (t.lineIdx === p.lineIdx || t.value <= p.value + 0.005) continue;
      const after = p.lineIdx > t.lineIdx;
      if (!pPay && !(after && p.lineIdx - t.lineIdx <= 4)) continue;
      const diff = t.value - p.value;
      const lo = Math.min(t.lineIdx, p.lineIdx), hi = Math.max(t.lineIdx, p.lineIdx);
      let ok = false;
      let dsum = 0, dcount = 0;
      for (const d of ds) {
        if (d.lineIdx === p.lineIdx || d.lineIdx === t.lineIdx) continue;
        const between = d.lineIdx > lo && d.lineIdx < hi;
        if (!pPay && !between) continue;
        if (Math.abs(Math.abs(d.value) - diff) < 0.015) { ok = true; break; }
        if (between) { dsum += Math.abs(d.value); dcount++; }
      }
      if (!ok && dcount >= 2 && Math.abs(dsum - diff) < 0.015) ok = true;
      if (!ok && hi - lo <= 8) {
        for (let k = lo; k <= hi && !ok; k++) {
          for (const pc of infos[k].pcts) if (Math.abs(t.value * (1 - pc / 100) - p.value) < 0.015) { ok = true; break; }
        }
      }
      if (!ok && pPay && after && hi - lo <= 8) {
        for (let li = lo + 1; li < hi && !ok; li++) {
          for (const x of candAt[li]) if (Math.abs(Math.abs(x.value) - diff) < 0.015) { ok = true; break; }
        }
      }
      if (ok) {
        let seen = false;
        for (const v of payValues) if (Math.abs(v - p.value) < 0.005) seen = true;
        if (!seen) { payValues.push(p.value); totValues.push(t.value); }
        break;
      }
    }
    if (payValues.length > 50) return;
  }
  if (payValues.length === 0) return;
  if (payValues.length === 1) {
    pairs.push(payValues[0]);
    pairs.push(totValues[0]);
    for (const c of all) {
      if (Math.abs(c.value - payValues[0]) < 0.005 && (!c.label.neg || c.label.payment)) {
        c.score += 3;
        c.confirmed = true;
        if (c.method === "largest" || c.method === "keyword-weak" || c.method === "sum-check") c.method = "deduction";
      } else if (Math.abs(c.value - totValues[0]) < 0.005) c.score -= 2;
    }
    return;
  }
  // several invoices each paid with a deduction: the grand total is the sum of the payments
  let sum = 0;
  for (const v of payValues) sum += v;
  for (const c of all) if (Math.abs(c.value - sum) < 0.015 && (c.label.strong || c.method === "column-sum")) { c.score += 2; c.confirmed = true; }
}

function chooseCurrency(best: Candidate | null, infos: LineInfo[], valueLine: string): { code: string; competing: boolean; codes: string } {
  // Currency token closest to the amount in its line, else in the line, else the document's most frequent one.
  const counts: { [k: string]: number } = {};
  const order: string[] = [];
  let anyCode = "";
  for (const inf of infos) {
    CURRENCY_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CURRENCY_TOKEN.exec(inf.text)) !== null) {
      const code = currencyCode(m[0]);
      if (inf.label.neg && !inf.header) continue;
      if (anyCode === "") anyCode = code;
      if (inf.amounts.length === 0) continue;
      if (counts[code] === undefined) { counts[code] = 0; order.push(code); }
      counts[code]++;
    }
  }
  CURRENCY_TOKEN.lastIndex = 0;
  let docCode = "";
  for (const k of order) if (docCode === "" || counts[k] > counts[docCode]) docCode = k;
  let code = "";
  if (best !== null) {
    let bestDist = 1e9;
    let m: RegExpExecArray | null;
    const at = best.charIdx, endAt = best.charIdx + best.amount.length;
    while ((m = CURRENCY_TOKEN.exec(valueLine)) !== null) {
      const d = m.index >= endAt ? m.index - endAt : at - (m.index + m[0].length);
      if (d < bestDist) { bestDist = d; code = currencyCode(m[0]); }
    }
    CURRENCY_TOKEN.lastIndex = 0;
    if (code === "" && best.method === "keyword-next-line") {
      while ((m = CURRENCY_TOKEN.exec(best.line)) !== null) { code = currencyCode(m[0]); break; }
      CURRENCY_TOKEN.lastIndex = 0;
    }
  }
  if (code === "") code = docCode !== "" ? docCode : anyCode !== "" ? anyCode : "EUR";
  return { code: code, competing: order.length >= 2, codes: order.join("/") };
}

function currencyCode(tok: string): string {
  if (tok === "€" || /^euro$/i.test(tok)) return "EUR";
  if (tok === "$") return "USD";
  if (tok === "£") return "GBP";
  if (tok === "¥") return "JPY";
  if (tok === "zł") return "PLN";
  if (tok === "Kč") return "CZK";
  if (tok === "SFr" || tok === "Fr.") return "CHF";
  return tok;
}

function emptyInfo(text: string): LineInfo {
  const none: LabelInfo = { strong: false, payment: false, weak: false, neg: false, ded: false };
  return { text: text, amounts: [], labels: [], lineLabel: [], own: [], cols: [], pcts: [], label: none, header: false, risky: false, payBonus: false, copy: false, wrapped: "", grossPay: false, payCol: false, quoted: false, sents: [] };
}

function downgrade(conf: string): string {
  return conf === "high" ? "medium" : "low";
}

function nettingChain(infos: LineInfo[], candAt: Candidate[][], pairs: number[]): void {
  // Box "Rechnungsbetrag 48.300,00 / Delkredere 966,00 / Bonus 724,50 / Zahlbetrag 46.609,50": the first amount minus the
  // deduction lines between equals the last one -> the last one is what was paid. Every line in between is a labelled
  // deduction or a negative amount; all are single-amount lines. pairs receives (paid, first) values.
  for (let p = 2; p < infos.length; p++) {
    if (candAt[p].length !== 1) continue;
    const pc = candAt[p][0];
    if (pc.value <= 0 || !pc.ownLabel || pc.copy || (pc.label.ded && !pc.label.payment) || (pc.label.neg && !pc.label.payment)) continue;
    // unlabelled lines in between ("ZR-Kondition 966,00") only when the last line is worded as a payment
    const plbl = labelOf(pc, infos);
    const payWord = (pc.label.payment || PAY_START.test(plbl)) && !ITEM_REF.test(plbl);
    let dsum = 0, dn = 0, plain = 0, plainSum = 0;
    for (let t = p - 1; t >= 0 && t >= p - 8; t--) {
      const row = candAt[t];
      if (row.length === 0) { if (infos[t].text.length === 0 || infos[t].header) break; continue; }
      if (row.length !== 1) break;
      const c = row[0];
      if (c.copy || !c.ownLabel) break;
      const isDed = (c.label.ded && !c.label.payment) || c.value < 0 || c.col === "ded" || c.col === "prev";
      if (isDed) { dsum += Math.abs(c.value); dn++; continue; }
      if (dn >= 1 && c.value > pc.value && Math.abs(c.value - dsum - pc.value) < 0.015 && (plain === 0 || plainSum < 0.5 * c.value)) {
        if (!pc.confirmed) pc.score += 3;
        pc.confirmed = true;
        if (pc.method === "largest" || pc.method === "keyword-weak") pc.method = "deduction";
        c.score -= 2;
        pairs.push(pc.value);
        pairs.push(c.value);
        break;
      }
      // a plain amount line may be an unlabelled deduction ("ZR-Kondition 966,00"), up to three of them; an invoice line
      // ("Rechnung 4711 4.000,00") makes the block an itemisation instead
      if (!payWord || c.value <= 0 || c.label.strong || c.label.payment || plain >= 3 || ITEM_REF.test(labelOf(c, infos))) break;
      dsum += c.value;
      plainSum += c.value;
      dn++;
      plain++;
    }
  }
}

function labelOf(c: Candidate, infos: LineInfo[]): string {
  // Label text of a candidate: the text before the amount (back to the previous amount), the label line of a
  // keyword-next-line candidate, or the wrapped label.
  const inf = infos[c.lineIdx];
  if (c.pos < 0) { const k = c.line.indexOf(" | "); return k >= 0 ? c.line.substring(0, k) : c.line; }
  if (inf.wrapped !== "") return inf.wrapped;
  const start = c.pos > 0 ? inf.amounts[c.pos - 1].end : 0;
  return inf.text.substring(start, c.charIdx);
}

function isTransferCand(c: Candidate, infos: LineInfo[]): boolean {
  // An amount with an explicit transfer label of its own ("Überweisungsbetrag 3.454,00"), not a table cell.
  if (c.value <= 0 || c.copy || !c.ownLabel || !c.label.payment || (c.label.ded && !c.label.payment)) return false;
  if (infos[c.lineIdx].amounts.length > 2) return false;
  return TRANSFER_LABEL.test(labelOf(c, infos));
}

function summedTransferLabel(c: Candidate, infos: LineInfo[]): boolean {
  // "Summe Zahlbetrag", "Total payment amount": the sum of a payment column, not an explicit transfer amount.
  const lbl = labelOf(c, infos);
  const m = TRANSFER_LABEL.exec(lbl);
  return m !== null && /\b(?:summe|sum|total)\b[\s:]*(?:der |aller |of (?:the )?)?$/i.test(lbl.substring(0, m.index));
}

function deductionLines(infos: LineInfo[]): number[] {
  // Deductions written as lines, in document order, as (run, value) pairs: a labelled deduction or a negative amount at
  // the end of a line outside the table columns ("abzüglich Regulierungsgebühr 0,8 % vom Bruttobetrag (14.077,53 EUR)
  // -112,62", "Delkredere 3,0 %   120,00") and the deduction cells of a table total row ("Summe ... Skonto ...").
  // A line with another amount in between starts a new run.
  const out: number[] = [];
  let run = 0, last = -1;
  for (let i = 0; i < infos.length && out.length < 400; i++) {
    const inf = infos[i];
    const k = inf.amounts.length;
    if (k === 0) continue;
    const before = out.length;
    if (!inf.copy && !inf.quoted) {
      const lab = inf.labels[k - 1];
      // a deduction label wrapped onto the line above ("abzüglich Regulierungsgebühr 0,8 % vom Bruttobetrag" /
      // "(14.077,53 EUR)   -112,62")
      const up = i > 0 && infos[i - 1].amounts.length === 0 && infos[i - 1].label.ded && !infos[i - 1].label.payment && !hasWords(inf.text.substring(0, inf.amounts[0].index));
      // a deduction line aligned with the table columns keeps its own label ("abzüglich Gebühr  (14.077,53)  -112,62")
      const dedRow = inf.cols[k - 1] === "" || (k <= 2 && inf.label.ded && !inf.label.payment && !inf.label.strong);
      if (dedRow && !(lab.payment && !up)) {
        const v = inf.amounts[k - 1].value;
        if (v !== 0 && ((lab.ded && !lab.payment) || v < 0 || up)) {
          out.push(run);
          out.push(Math.abs(v));
        }
      } else if (inf.cols[k - 1] !== "" && inf.label.strong) {
        for (let j = 0; j < k; j++) if (inf.cols[j] === "ded" && inf.amounts[j].value !== 0) { out.push(run); out.push(Math.abs(inf.amounts[j].value)); }
      }
    }
    if (out.length > before) last = i;
    else if (last >= 0) { run++; last = -1; }
  }
  return out;
}

function deductionsExplain(diff: number, ded: number[]): boolean {
  // diff equals the sum of some deductions (any combination when there are at most 10, e.g. fee and VAT on the fee with a
  // subtotal line in between), else one deduction, the sum of consecutive deductions of one run, or the sum of all.
  if (diff < 0.005) return false;
  let all = 0;
  for (let q = 1; q < ded.length; q += 2) all += ded[q];
  if (Math.abs(all - diff) < 0.015) return true;
  const nd = ded.length / 2;
  if (nd <= 10) {
    for (let mask = 1; mask < (1 << nd); mask++) {
      let sum = 0;
      for (let q = 0; q < nd; q++) if ((mask & (1 << q)) !== 0) sum += ded[2 * q + 1];
      if (Math.abs(sum - diff) < 0.015) return true;
    }
    return false;
  }
  for (let a = 0; a < ded.length; a += 2) {
    let sum = 0;
    for (let b = a; b < ded.length && b <= a + 24; b += 2) {
      if (ded[b] !== ded[a]) break;
      sum += ded[b + 1];
      if (Math.abs(sum - diff) < 0.015) return true;
    }
  }
  return false;
}

function dueWithVat(infos: LineInfo[], end: number): boolean {
  // An "amount due" line and a VAT line with amounts (an invoice) before line end.
  let due = false, vat = false;
  for (let i = 0; i < end; i++) {
    const inf = infos[i];
    if (inf.amounts.length === 0) continue;
    if (DUE_LABEL.test(inf.text)) due = true;
    if (VAT_LINE.test(inf.text)) vat = true;
  }
  return due && vat;
}

function integerCurrencyAmount(s: string): boolean {
  // A currency amount without decimals ("1.000 EUR", "€ 500"): a value that findAmountsInLine does not read.
  const re = /(\d[\d.,']*) ?(?:EUR(?![A-Za-z])|€|CHF(?![A-Za-z]))|(?:EUR|€|CHF) ?(\d[\d.,']*)/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s)) !== null && n < 200) {
    n++;
    let num = m[1] || m[2] || "";
    if (/[.,]$/.test(num)) num = num.substring(0, num.length - 1);
    if (num.length === 0 || /[.,]\d\d$/.test(num)) continue;
    // dates, years and numbered references are no amounts ("vom 29.10.2026 EUR", "2026 EUR", "Nr. 4711 EUR")
    if (/\d[.\/-]\d{1,2}[.\/-]\d/.test(num) || /^(?:19|20)\d\d$/.test(num)) continue;
    if (m[1] && NUMBER_LABEL_BEFORE.test(s.substring(Math.max(0, m.index - 14), m.index))) continue;
    // exchange rates ("Kurs 1 EUR = 1,0700 USD", "1 USD = 0,9346 EUR") are no amounts
    if (/^\s*=/.test(s.substring(m.index + m[0].length)) || /=\s*$/.test(s.substring(Math.max(0, m.index - 3), m.index)) || /[.,]\d{4,}$/.test(num)) continue;
    return true;
  }
  return false;
}

function distinctMatches(re: RegExp, s: string): number {
  // Number of different matches of a global regex in s (at most 10).
  const seen: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null && seen.length < 10) {
    const k = m[0].toLowerCase();
    if (seen.indexOf(k) < 0) seen.push(k);
  }
  re.lastIndex = 0;
  return seen.length;
}

// Document type. kind "advice": advice title in the title area, bank credit or bank transfer form; "other": another
// document type (why = reason text); "": unknown. quoteStart: first line of the quoted mail in an e-mail reply
// (lines.length if none); payer: the writer states a payment; foreignPayer: payer and no open amount (foreign payment
// words then count as payment wording); ownText: the text before the quoted mail.
interface DocInfo { kind: string; why: string; transferForm: boolean; quoteStart: number; payer: boolean; foreignPayer: boolean; ownText: string }

function classifyDocument(infos: LineInfo[], heights: number[] | null): DocInfo {
  const n = infos.length;
  const doc: DocInfo = { kind: "", why: "", transferForm: false, quoteStart: n, payer: false, foreignPayer: false, ownText: "" };
  // e-mail printout: a header block near the top; a later "Von:" block or "Am ... schrieb" starts the quoted mail
  // (the first block of header lines; one other line in between is allowed)
  let headers = 0, lastHeader = -1;
  for (let i = 0; i < n && i < 15; i++) {
    if (MAIL_HEADER.test(infos[i].text)) { headers++; lastHeader = i; }
    else if (headers > 0 && i - lastHeader > 1) break;
  }
  const email = headers >= 2;
  for (let i = email ? lastHeader + 1 : 1; i < n; i++) {
    const t = infos[i].text;
    let q = QUOTE_MARK.test(t);
    if (!q && email && MAIL_FROM.test(t)) {
      for (let k = i + 1; k <= i + 4 && k < n && !q; k++) if (MAIL_HEADER.test(infos[k].text)) q = true;
    }
    if (q) { doc.quoteStart = i; break; }
  }
  if (doc.quoteStart < n) {
    // a forwarded mail without amounts of its own: the quoted part is the document
    let ownAmount = false;
    for (let i = 0; i < doc.quoteStart && !ownAmount; i++) if (infos[i].amounts.length > 0 && !MAIL_HEADER.test(infos[i].text)) ownAmount = true;
    if (!ownAmount) doc.quoteStart = n;
  }
  const parts: string[] = [];
  // the subject of the writer's own mail (not of a reply) also states a request ("Betreff: Zahlungsavis fehlt")
  let ownSubject = "";
  for (let i = 0; i < doc.quoteStart; i++) {
    if (!(email && MAIL_HEADER.test(infos[i].text))) { parts.push(infos[i].text); continue; }
    const sm = MAIL_SUBJECT.exec(infos[i].text);
    if (sm !== null && i <= lastHeader && !REPLY_PREFIX.test(infos[i].text.substring(sm[0].length)) && !FORWARD_PREFIX.test(infos[i].text.substring(sm[0].length))) ownSubject = infos[i].text.substring(sm[0].length);
  }
  const own = parts.join("\n");
  doc.ownText = own;
  doc.payer = PAYER_STATEMENT.test(own);
  // a title in another language ("Avis de paiement") counts only with a payment statement and no open amount (bills,
  // direct debit notices and reminders use the same titles)
  const openAmount = FOREIGN_OPEN.test(own) || DUE_LABEL.test(own) || DEMAND.test(own) || NOT_PAID.test(own);
  doc.foreignPayer = doc.payer && !openAmount;
  const foreignTitleOk = (doc.payer || POST_PAYMENT.test(own)) && !openAmount;
  // title area: page 1 (before a quoted mail) up to the salutation or the first table header (at most 25 lines), plus
  // lines in a larger font
  let pageEnd = doc.quoteStart;
  for (let i = 0; i < pageEnd; i++) if (infos[i].text.length === 0) { pageEnd = i; break; }
  const zone: number[] = [];
  const large: number[] = [];
  for (let i = 0; i < pageEnd && i < 25; i++) {
    if (i > 0 && (SALUTATION.test(infos[i].text) || infos[i].header)) break;
    zone.push(i);
  }
  if (heights !== null) {
    const hs: number[] = [];
    for (let i = 0; i < pageEnd; i++) if (heights[i] > 0) hs.push(heights[i]);
    hs.sort((a, b) => a - b);
    const med = hs.length > 0 ? hs[Math.floor(hs.length / 2)] : 0;
    for (let i = 0; i < pageEnd && i < 45; i++) {
      if (med <= 0 || heights[i] < 1.3 * med || infos[i].text.length > 80) continue;
      large.push(i);
      if (zone.indexOf(i) < 0) zone.push(i);
    }
  }
  // otherWeak: otherT is only an invoice or order number line ("Rechnung Nr. 2026-551", "DUPLIKAT") or a cited
  // document outside a stand-alone title ("Lieferschein-Nr.", subject "Lieferschein 80012345")
  let adviceT = false, transferT = false, creditT = false, otherT = "", otherWeak = false;
  // recipient address block: up to four short lines right above a "12345 Stadt" line (left column only)
  const addrLine: boolean[] = [];
  for (let i = 0; i < n; i++) addrLine.push(false);
  for (const i of zone) {
    const fc = lineCells(infos[i].text);
    if (fc.length < 2 || !ZIP_CITY.test(infos[i].text.substring(fc[0], fc[1]))) continue;
    addrLine[i] = true;
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
      const kc = lineCells(infos[k].text);
      if (kc.length < 2 || kc[1] - kc[0] > 50 || infos[k].amounts.length > 0 || large.indexOf(k) >= 0 || zone.indexOf(k) < 0) break;
      addrLine[k] = true;
    }
  }
  for (const i of zone) {
    let t = infos[i].text;
    let reply = false, subject = false;
    if (email && MAIL_HEADER.test(t)) {
      const sm = MAIL_SUBJECT.exec(t);
      if (sm === null) continue;
      t = t.substring(sm[0].length);
      subject = true;
      reply = REPLY_PREFIX.test(t); // the subject of a reply is the title of the other party's mail
    }
    const cells = lineCells(t);
    // a title line has no amount ("Kostenvoranschlag der Werkstatt   2.645,00" is a field); a section word right above
    // amount rows ("Rechnung" / "RE-0917   1.000,00") is no title unless it is printed larger
    if (infos[i].amounts.length > 0 && !subject) continue;
    const section = i + 1 < n && infos[i + 1].amounts.length > 0 && large.indexOf(i) < 0;
    let refNext = false;
    for (let c = 0; c + 1 < cells.length; c += 2) {
      const cell = t.substring(cells[c], cells[c + 1]);
      // a reference field ("Ihr Zeichen:   Mahnung vom 06.10.2026", "Bezug: Zahlungserinnerung"), a department or an address
      // line ("Personalabteilung / Entgeltabrechnung") names another document or a department, not this document
      const isRef = refNext;
      refNext = false;
      const rf = REF_FIELD.exec(cell);
      if (rf !== null && rf[0].length === cell.length) { refNext = true; continue; }
      if (isRef || (rf !== null && (/:\s*$/.test(rf[0]) || REF_STRONG.test(cell)))) continue;
      const dm = DEPT_WORD.exec(cell);
      const deptOrAddr = (dm !== null && !/\s/.test(cell.substring(0, dm.index).trim()) && !/[:\u2013\u2014|]|\s[-\/]\s/.test(cell)) || (c === 0 && addrLine[i] && !subject);
      // a long title line counts when it starts with the advice title or names it after a dash ("Erstattung nach dem
      // AAG – Zahlungsmitteilung")
      const am = AVIS_TITLE.exec(cell);
      const longTitle = am !== null && cell.length <= 100 && (am.index === 0 || /[-\u2013\u2014:|\/]\s*$/.test(cell.substring(0, am.index)));
      if (cell.length > 60 && !longTitle) continue;
      if (am !== null && (DE_EN_AVIS_TITLE.test(cell) || foreignTitleOk)) adviceT = true;
      if (deptOrAddr) continue;
      if (TRANSFER_TITLE.test(cell)) transferT = true;
      // invoice and credit note titles stand alone on their line ("Rechnung   RE-4711" is a field) or in a larger font
      // (a mail subject "Rechnung 2026-551" refers to the invoice)
      const alone = !subject && !section && (cells.length === 2 || large.indexOf(i) >= 0);
      if (alone && CREDIT_TITLE.test(cell)) creditT = true;
      if ((otherT !== "" && !otherWeak) || reply) continue;
      const m = OTHER_TITLE.exec(cell);
      if (m !== null && !REF_BEFORE.test(cell.substring(0, m.index))) {
        const weak = !alone && REF_DOC.test(m[0]);
        if (otherT === "" || !weak) { otherT = m[0]; otherWeak = weak; }
      }
      else if (otherT === "" && alone && cell.length <= 50 && (INVOICE_START.test(cell) || ORDER_START.test(cell)) && !/\d[.,]\d\d(?![\d.])/.test(cell) && !PAYMENT_MARKER.test(cell) && !FOREIGN_PAYMENT_MARKER.test(cell)) { otherT = cell; otherWeak = true; }
    }
  }
  const bank = distinctMatches(BANK_FIELD, own) >= 2;
  // the advice naming itself is removed first; dots in numbers, dates and abbreviations do not end a sentence here
  const plain = (ownSubject + "\n" + own).replace(SELF_ADVICE, " ").replace(REQUEST_REF, " ").replace(/(\d)\.(?=\d)/g, "$1").replace(ABBREV_PAIR, "$1$2").replace(ABBREV_DOT, "$1");
  if (REQUEST_ADVICE.test(plain)) { doc.kind = "other"; doc.why = "asks for a payment advice - not an advice itself"; return doc; }
  if (adviceT) doc.kind = "advice";
  else if (transferT && bank && (otherT === "" || ORDER_CONFIRM.test(otherT))) doc.kind = "advice";
  else if (creditT && bank) doc.kind = "advice";
  else if (creditT) { doc.kind = "other"; doc.why = "credit note title - not a payment advice?"; }
  // an invoice / order number line or a cited document in a payer's letter ("wir haben ... überwiesen") is a reference
  else if (otherT !== "" && !(otherWeak && PAYER_DONE.test(own))) { doc.kind = "other"; doc.why = "'" + otherT + "' - not a payment advice?"; }
  // the payee writes about money it received (without an advice title): not an advice
  else if (PAYEE_VIEW.test(plain.split(/[.\n]/).filter((x) => !REFUND_WORD.test(x)).join("."))) { doc.kind = "other"; doc.why = "payee's letter about a received payment - not a payment advice?"; }
  else if (AVIS_TITLE.test(own) && (DE_EN_AVIS_TITLE.test(own) || foreignTitleOk)) doc.kind = "advice";
  else {
    let m = NO_PAYMENT.exec(own);
    if (m === null) m = DEMAND.exec(own);
    if (m === null) m = DUNNING.exec(own);
    // "bezugnehmend auf Ihre Mahnung", "Ihre Zahlungserinnerung vom ...": the other party's document, not this one
    if (m === null) m = NON_PAYMENT_MARKER.exec(PAYER_DONE.test(own) ? own.replace(REF_PHRASE, " ").replace(DELIVERY_REF, " ") : own);
    if (m !== null) { doc.kind = "other"; doc.why = "'" + m[0] + "' - not a payment advice?"; }
    else if (!PAYER_DONE.test(own) && dueWithVat(infos, doc.quoteStart)) { doc.kind = "other"; doc.why = "amount due with VAT - invoice?"; }
    else if (distinctMatches(PAYROLL_WORD, own) >= 2) { doc.kind = "other"; doc.why = "payroll words - not a payment advice?"; }
    else if (distinctMatches(EXPENSE_WORD, own) >= 2) { doc.kind = "other"; doc.why = "travel expense words - not a payment advice?"; }
    else if (distinctMatches(SHIPPING_WORD, own) >= 3) { doc.kind = "other"; doc.why = "shipping words - not a payment advice?"; }
  }
  doc.transferForm = doc.kind === "advice" && transferT && bank;
  return doc;
}

function pickAmount(lines: string[], extraKeywords: string): AmountPick {
  const normLines: string[] = [];
  // a real text line is short; capping keeps the (super)linear regexes below cheap on garbage lines
  for (const l of lines) normLines.push(normalizeLine(l.length > 2000 ? l.substring(0, 2000) : l));
  const english = detectEnglishFormat(normLines);
  let extra: RegExp | null = null;
  const ek: string[] = [];
  for (const part of extraKeywords.split(/[,;|]/)) { const t = part.trim(); if (t.length > 0) ek.push(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
  if (ek.length > 0) extra = new RegExp(ek.join("|"), "i");

  // ---- per-line analysis: amounts and the label of each amount
  const infos: LineInfo[] = [];
  for (let i = 0; i < normLines.length; i++) {
    const ln = normLines[i];
    const inf = emptyInfo(ln);
    inf.amounts = findAmountsInLine(ln, english);
    inf.label = segmentLabel(ln, extra, false);
    const reP = /(\d{1,2}(?:[.,]\d{1,2})?) ?%/g;
    let pm: RegExpExecArray | null;
    while ((pm = reP.exec(ln)) !== null) { const p = parseFloat(pm[1].replace(",", ".")); if (p > 0 && p <= 10) inf.pcts.push(p); }
    const k = inf.amounts.length;
    // a sentence that wraps into this line ("... bereits am 01.10.2026 überwiesen. Heute überweisen" / "wir den Restbetrag
    // von 3.450,00 €"): its start on the previous prose line belongs to the first amount here
    let lead = "";
    if (k > 0 && i > 0 && /^[a-zäöüß]/.test(ln)) {
      const pv = infos[i - 1];
      const pk = pv.amounts.length;
      let tail = pk > 0 ? pv.text.substring(pv.amounts[pk - 1].end) : pv.text;
      tail = /[.!?:]\s*$/.test(tail) ? "" : tail.substring(lastSentenceStart(tail));
      if (pv.text.length >= 50 && lineCells(pv.text).length === 2 && tail.length <= 80 && hasWords(tail)) lead = tail.trim() + " ";
    }
    // sentence ends of the whole line, found once per line (as lastSentenceStart() finds them in the text before an amount)
    const lnEnds: number[] = [];
    let ep = 0;
    if (k > 0) {
      let e = sentenceEnd(ln, 0);
      while (e >= 0 && lnEnds.length < 200) { lnEnds.push(e); e = sentenceEnd(ln, e); }
    }
    const twoCells = k > 0 && lineCells(ln).length === 2;
    for (let j = 0; j < k; j++) {
      const a = inf.amounts[j];
      let pre = ln.substring(j === 0 ? 0 : inf.amounts[j - 1].end, a.index);
      // wrapped letter text "... überwiesen haben. Die Zahlung betrifft Rechnung X über 1.000,00": the verb ends an earlier sentence
      const sv = pre.search(/(?:überwiesen|ueberwiesen|gutgeschrieben|angewiesen|beglichen|bezahlt|ausgeglichen)(?: haben| hat| wurde| worden| wird)?\. /i);
      if (sv >= 0) pre = pre.substring(pre.indexOf(". ", sv) + 2);
      // a payment word belongs to its own sentence: "... haben wir schon am 02.10.2026 gezahlt. Heute überweisen wir ..."
      let cut = sv >= 0;
      const ls = lastSentenceStart(pre);
      if (ls > 0 && SENT_PAY.test(pre.substring(0, ls)) && !ANAPHOR.test(pre.substring(ls))) { pre = pre.substring(ls); cut = true; }
      if (j === 0 && ls === 0 && !cut) pre = lead + pre;
      // the whole sentence around the amount (for earlier / current payments); its start is the last sentence end of the
      // line before the amount, and a sentence over 400 characters is dropped, so the scans after the amount stop there
      while (ep < lnEnds.length && lnEnds[ep] < a.index) ep++;
      const bs = ep > 0 ? lnEnds[ep - 1] : 0;
      let sent = (bs === 0 ? lead : "") + ln.substring(bs, a.index) + a.text;
      if (sent.length <= 400) {
        const rest = ln.substring(a.end, Math.min(ln.length, a.end + 401 - sent.length));
        const re0 = sentenceEnd(rest, 0);
        if (re0 >= 0) sent += rest.substring(0, re0);
        else {
          sent += rest;
          if (sent.length <= 400 && !/[.!?]\s*$/.test(rest) && i + 1 < normLines.length && /^[a-zäöüß]/.test(normLines[i + 1]) && twoCells) {
            const nx = normLines[i + 1].substring(0, 401 - sent.length);
            const ne = sentenceEnd(nx, 0);
            sent += " " + (ne >= 0 ? nx.substring(0, ne) : nx);
          }
        }
      }
      inf.sents.push(sent.length > 400 ? "" : sent);
      const own = j === 0 ? true : hasWords(pre);
      inf.own.push(j > 0 && own);
      inf.lineLabel.push(j === 0 || !own);
      let lab: LabelInfo;
      if (j === 0 || own) lab = segmentLabel(pre, extra, j > 0 && !cut);
      else { const l0 = inf.labels[0]; lab = { strong: l0.strong, payment: l0.payment, weak: l0.weak, neg: l0.neg, ded: l0.ded }; }
      if (!lab.payment && (j === 0 || own)) {
        // payment verb after the amount: "Wir haben 3.454,00 EUR überwiesen" (in the same sentence)
        let post = ln.substring(a.end, j + 1 < k ? inf.amounts[j + 1].index : ln.length);
        const pe = sentenceEnd(post, 0);
        if (pe >= 0) post = post.substring(0, pe);
        const pi = post.search(POST_PAYMENT);
        const ni = post.search(NEGATIVE_KEYWORDS);
        if (pi >= 0 && (ni < 0 || pi < ni)) { lab.payment = true; lab.strong = true; }
      }
      // the writer pays the rest today ("Heute überweisen wir den Restbetrag von 3.450,00 €"): "Restbetrag" names the payment
      if (lab.payment && lab.neg && (j === 0 || own) && FIRST_PERSON.test(sent) && CURRENT_WORD.test(sent) && REST_WORD.test(pre) && !NEGATIVE_KEYWORDS.test(pre.replace(REST_WORD, " "))) { lab.neg = false; lab.strong = true; }
      inf.labels.push(lab);
      inf.cols.push("");
    }
    infos.push(inf);
  }
  // wrapped letter text "... einen Betrag von 3.454,00 EUR" / "an Sie überwiesen haben.": the verb at the start of the next line belongs to the amount ending this line
  for (let i = 0; i + 1 < infos.length; i++) {
    const inf = infos[i], nx = infos[i + 1];
    const k = inf.amounts.length;
    if (k === 0) continue;
    const lab = inf.labels[k - 1];
    if (lab.payment) continue;
    // "abzüglich Skonto einen Betrag von 3.454,00 EUR": the deduction words describe the paid amount
    const intro = /\beinen (?:gesamt)?betrag von\s*$/i.test(inf.text.substring(0, inf.amounts[k - 1].index));
    if (lab.neg && !intro) continue;
    if (hasWords(inf.text.substring(inf.amounts[k - 1].end))) continue;
    const lead0 = nx.amounts.length > 0 ? nx.text.substring(0, nx.amounts[0].index) : nx.text;
    const dot = lead0.indexOf(". ");
    const lead = dot >= 0 ? lead0.substring(0, dot) : lead0;
    // only a sentence that wraps: words before the amount and a lower-case continuation on the next line
    if (!/^[a-zäöüß]/.test(nx.text) || (inf.text.substring(0, inf.amounts[k - 1].index).match(/[A-Za-zÄÖÜäöüß]{2,}/g) || []).length < 3) continue;
    if (lead.length <= 40 && POST_PAYMENT.test(lead) && !NEGATIVE_KEYWORDS.test(lead)) { lab.payment = true; lab.strong = true; lab.neg = false; lab.ded = false; }
  }
  mapTableColumns(infos);
  // table headers written with single spaces ("Rechnung   Datum Betrag Skonto Zahlbetrag")
  for (const inf of infos) {
    if (inf.amounts.length === 0 && !inf.header && (inf.text.match(/datum|date|betrag|skonto|rechnung|beleg|amount|invoice|discount/gi) || []).length >= 3) inf.header = true;
  }
  markInvoiceCopies(infos);
  // label wrapped around its value in a narrow column: "Überwei-" / "3.454,00 €" / "sungsbetrag"
  for (let i = 1; i + 1 < infos.length; i++) {
    const inf = infos[i];
    if (inf.amounts.length !== 1 || hasWords(inf.text)) continue;
    const up = infos[i - 1], down = infos[i + 1];
    if (up.amounts.length > 0 || down.amounts.length > 0 || up.header || down.header || !hasWords(up.text) || !hasWords(down.text)) continue;
    if (up.text.length > 40 || down.text.length > 40 || /:\s*$/.test(up.text) || /:\s*$/.test(down.text)) continue;
    // the line below must be a continuation, not the label of the next value
    if (i + 2 < infos.length && infos[i + 2].amounts.length > 0 && !hasWords(infos[i + 2].text)) continue;
    const joined = /[a-zäöüß]-$/.test(up.text) ? up.text.substring(0, up.text.length - 1) + down.text : up.text + " " + down.text;
    inf.labels[0] = segmentLabel(joined, extra, false);
    inf.label = inf.labels[0];
    inf.wrapped = joined;
  }
  // ---- document type (title area, strong phrases), quoted e-mail part, bank transfer forms
  const doc = classifyDocument(infos, lastLineHeights.length === lines.length ? lastLineHeights : null);
  for (let i = doc.quoteStart; i < infos.length; i++) infos[i].quoted = true;
  // ---- earlier and current payments in the writer's own sentences ("Die erste Rate über 2.500,00 € haben wir bereits am
  // 01.10.2026 überwiesen. Heute überweisen wir den Restbetrag von 3.450,00 €."): an earlier payment is no candidate for
  // the current one when another payment sentence names a different amount
  const curPayVals: number[] = [];
  {
    const priorAt: number[] = [];
    for (let i = 0; i < doc.quoteStart; i++) {
      const inf = infos[i];
      for (let j = 0; j < inf.amounts.length && j < inf.sents.length; j++) {
        const st = inf.sents[j];
        const flat = st.replace(/(\d)\.(?=\d)/g, "$1");
        // "... kürzen wir den Betrag um 10 % und überweisen heute 1.071,00 EUR": the writer's payment verb today, in the same
        // sentence before the amount, labels the amount as the payment
        const lb = inf.labels[j];
        if (st !== "" && !lb.payment && !lb.ded && !lb.neg && inf.cols[j] === "" && inf.amounts[j].value > 0 && FIRST_PERSON.test(flat) && /\b(?:heute|hiermit|today|herewith)\b/i.test(flat) && !FUTURE_SENT.test(flat)) {
          const k0 = st.indexOf(inf.amounts[j].text);
          if (k0 > 0 && SENT_PAY.test(st.substring(0, k0))) { lb.payment = true; lb.strong = true; }
        }
        // a deduction paid along ("We have paid the bank charges of EUR 15.00") is no payment of its own
        if (st === "" || !inf.labels[j].payment || inf.labels[j].ded || inf.amounts[j].value <= 0 || inf.cols[j] !== "") continue;
        if (!FIRST_PERSON.test(flat) || !SENT_PAY.test(flat)) continue;
        const curWord = CURRENT_WORD.test(flat);
        // a payment announced for later is neither today's payment nor an earlier one
        if (FUTURE_SENT.test(flat) && !curWord && !/\b(?:haben|hat|habe|have|has)\b/i.test(flat)) continue;
        if (PRIOR_SENT.test(flat.replace(PRIOR_ASIDE, " ")) && !curWord) { if (priorAt.length < 100) { priorAt.push(i); priorAt.push(j); } continue; }
        const v = inf.amounts[j].value;
        let seen = false;
        for (const x of curPayVals) if (Math.abs(x - v) < 0.005) seen = true;
        if (!seen && curPayVals.length < 50) curPayVals.push(v);
      }
    }
    for (let q = 0; q < priorAt.length && curPayVals.length > 0; q += 2) {
      const inf = infos[priorAt[q]];
      const j = priorAt[q + 1];
      let same = false;
      for (const x of curPayVals) if (Math.abs(x - inf.amounts[j].value) < 0.005) same = true;
      if (same) continue;
      const lab = inf.labels[j];
      lab.payment = false;
      lab.strong = false;
      lab.neg = true;
      lab.ded = true;
    }
  }
  if (doc.transferForm) {
    // "Betrag 1.850,00 EUR" in the payer bank's transfer confirmation is the transferred amount
    for (const inf of infos) {
      if (inf.amounts.length !== 1 || inf.quoted) continue;
      if (TRANSFER_FIELD.test(inf.text.substring(0, inf.amounts[0].index).trim())) { inf.labels[0].strong = true; inf.labels[0].payment = true; inf.labels[0].weak = true; }
    }
  }

  // ---- candidates
  const all: Candidate[] = [];
  const candAt: Candidate[][] = [];
  const n = Math.max(1, normLines.length);
  for (let i = 0; i < infos.length; i++) {
    const inf = infos[i];
    const row: Candidate[] = [];
    const k = inf.amounts.length;
    for (let j = 0; j < k; j++) {
      const a = inf.amounts[j];
      const lab = inf.labels[j];
      const c = newCandidate(a, inf.wrapped !== "" ? inf.wrapped + " | " + inf.text : inf.text, i, j, lab);
      c.lineLabel = inf.lineLabel[j];
      c.ownLabel = inf.wrapped !== "" || (j === 0 ? hasWords(inf.text.substring(0, a.index)) : inf.own[j]);
      c.col = inf.cols[j];
      c.risky = inf.risky && c.col !== "";
      c.copy = inf.copy || inf.quoted;
      let score = 0;
      if (lab.strong) { score += 5; c.method = "keyword"; }
      else if (lab.weak) { score += 1.5; c.method = "keyword-weak"; }
      if (c.col === "pay" && inf.payBonus) {
        if (!lab.payment) { lab.payment = true; score += 1.5; }
        score += 1;
        if (c.method === "largest" || c.method === "keyword-weak") c.method = "column-header";
      } else if (lab.payment) score += 1.5;
      if (lab.neg && !lab.payment) score -= 2;
      if (c.col === "ded" || c.col === "rest" || c.col === "vat" || c.col === "prev") score -= 2;
      if (c.col === "gross" && inf.payBonus) score -= 0.5;
      if (c.lineLabel && j === k - 1 && (c.col === "" || c.col === "pay")) score += 0.5; // right-most amount on the line
      const around = inf.text.substring(Math.max(0, a.index - 6), Math.min(inf.text.length, a.end + 6));
      if (/€|EUR|CHF|USD|GBP|PLN|CZK|SEK/.test(around)) score += 0.75;
      if (a.value === 0) score -= 3;
      if (inf.copy || inf.quoted) score -= 3;
      score += (i / n) * 0.5;
      c.score = score;
      if (!inf.quoted) all.push(c);
      row.push(c);
    }
    candAt.push(row);
  }
  // label line without amount: amount may be on the next line(s)
  for (let i = 0; i < infos.length; i++) {
    const inf = infos[i];
    if (inf.amounts.length > 0 || !inf.label.strong || inf.header || inf.quoted) continue;
    // an advice title ("Avviso di bonifico") is no label for the first table row
    if (AVIS_TITLE.test(inf.text) && !STRONG_KEYWORDS.test(inf.text.replace(AVIS_TITLE, " "))) continue;
    // an unreadable amount in the label line itself ("Zahlbetrag 3.454 EUR") – do not borrow from the next line
    // (only an amount-like number counts: thousands groups or a number next to a currency, not "Rechnung 4711" / "Avis 2026-0815")
    if (/\d{1,3}(?:[.']\d{3})+(?![\d,])|\d\s*(?:EUR|€|CHF|USD|GBP)\b|(?:EUR|€|CHF|USD|GBP)\s*\d/i.test(inf.text.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " "))) continue;
    for (let k = 1; k <= 2 && i + k < infos.length; k++) {
      const nx = infos[i + k];
      if (nx.header || nx.wrapped !== "" || nx.quoted) break; // "Wir überweisen Ihnen folgende Posten:" followed by a table
      if (nx.amounts.length === 0 && lineCells(nx.text).length >= 6) break; // header row of a table
      if (nx.amounts.length > 0) {
        // a row with several amounts ("Rechnung 4711   3.524,49   70,49") is the value of the label above only when
        // its last amount follows from the others (gross - Skonto = payment, net + VAT = gross)
        const kn = nx.amounts.length;
        if (kn >= 2) {
          const last = nx.amounts[kn - 1].value, first = nx.amounts[0].value;
          let fits = Math.abs(first - last) < 0.005;
          for (let q = 1; q < kn - 1 && !fits; q++) {
            const mid = Math.abs(nx.amounts[q].value);
            if (Math.abs(first - mid - last) < 0.015 || Math.abs(first + mid - last) < 0.015) fits = true;
          }
          if (!fits) break;
        }
        const a = nx.amounts[nx.amounts.length - 1];
        let score = 4 - k;
        if (nx.label.neg) score -= 2;
        if (inf.label.neg && !inf.label.payment) score -= 2.5; // label line looks like a table header (Rechnungsbetrag/Skonto …)
        if (inf.label.payment) score += 1.5;
        if (inf.text.length > 45) score -= 1;       // long line = probably a header row, not a label
        if (nx.amounts.length >= 3) score -= 1.5;   // next line is a table row
        if (/:\s*$/.test(inf.text)) score += 0.5;    // "Überweisungsbetrag:"
        if (inf.copy || nx.copy || inf.quoted || nx.quoted) score -= 3;
        if (a.value === 0) score -= 3;               // same zero penalty as on the label line itself
        score += ((i + k) / n) * 0.5;
        const c = newCandidate(a, inf.text + " | " + nx.text, i + k, -1, inf.label);
        c.method = "keyword-next-line";
        c.score = score;
        c.charIdx = a.index;
        c.copy = inf.copy || nx.copy || inf.quoted || nx.quoted;
        c.ownLabel = true;
        all.push(c);
        break;
      }
      if (nx.label.strong || (nx.label.neg && (/:\s*$/.test(nx.text) || nx.text.split(" ").length <= 2))) break;
    }
  }

  // ---- column sum: a total equals a run of 2+ rows directly above (same column, counted from the right)
  for (let i = 0; i < infos.length; i++) {
    const k = infos[i].amounts.length;
    for (let r = 0; r < k; r++) {
      const c = candAt[i][k - 1 - r];
      const v = c.value;
      if (v === 0 || !c.lineLabel) continue;
      let s = 0, cnt = 0, steps = 0, match = false, firstRow = -1;
      for (let j = i - 1; j >= 0 && steps < 80 && cnt < 40; j--) {
        steps++;
        const kj = infos[j].amounts.length;
        if (kj === 0) continue;
        if (r > 0 && kj !== k) break;
        const a = kj === k ? infos[j].amounts[kj - 1 - r] : infos[j].amounts[kj - 1];
        // a single deduction line above a payment ("abzüglich 2 % Skonto 71,40") reduces the run
        if (r === 0 && kj === 1 && infos[j].labels[0].ded && !infos[j].labels[0].payment) s -= Math.abs(a.value);
        else s += a.value;
        cnt++;
        if (cnt === 1) firstRow = j;
        if (cnt >= 2 && Math.abs(s - v) < 0.015) { match = true; break; }
      }
      // single row + total row with identical amounts ("RE1001 1.190,00 23,80 1.166,20" / "Summe 1.190,00 23,80 1.166,20")
      if (!match && k >= 2 && firstRow >= 0 && infos[i].label.strong && infos[firstRow].amounts.length === k) {
        let same = true;
        for (let q = 0; q < k; q++) if (Math.abs(infos[firstRow].amounts[q].value - infos[i].amounts[q].value) >= 0.005) same = false;
        match = same;
      }
      if (!match) continue;
      c.confirmed = true;
      if (r === 0) {
        c.score += 2.5;
        if (c.method === "largest" || c.method === "keyword-weak") c.method = "column-sum";
      }
    }
  }
  // total row "Summe 3.570,00 71,40 3.498,60": gross = deduction + payment, deduction small (Skonto) -> reward the payment
  for (let i = 0; i < infos.length; i++) {
    const inf = infos[i];
    const k = inf.amounts.length;
    if (k < 3 || !inf.label.strong) continue;
    let ai = 0;
    for (let j = 1; j < k; j++) if (inf.amounts[j].value > inf.amounts[ai].value) ai = j;
    const a = inf.amounts[ai].value;
    let done = false;
    for (let b = 0; b < k && !done; b++) {
      for (let c2 = b + 1; c2 < k && !done; c2++) {
        if (b === ai || c2 === ai) continue;
        const vb = inf.amounts[b].value, vc = inf.amounts[c2].value;
        if (vb <= 0 || vc <= 0 || Math.abs(a - vb - vc) >= 0.015) continue;
        if (Math.min(vb, vc) > 0.05 * a) continue;
        const big = vb >= vc ? b : c2;
        candAt[i][big].score += 2;
        candAt[i][big].confirmed = true;
        done = true;
      }
    }
  }
  // (paid, total) value pairs of netting chains: the total is explained by the payment and is no competitor
  const chainPairs: number[] = [];
  // the only data row (or the total row) of a table reconciles itself: gross - deduction columns = payment column;
  // the gross is then no competitor of the payment
  for (let i = 0; i < infos.length; i++) {
    const inf = infos[i];
    const k = inf.amounts.length;
    if (k < 3 || !inf.payBonus || inf.quoted) continue;
    let g = -1, p = -1, dsum = 0, nd = 0, other = false;
    for (let j = 0; j < k; j++) {
      const col = inf.cols[j];
      if (col === "gross") { if (g >= 0) other = true; g = j; }
      else if (col === "pay") { if (p >= 0) other = true; p = j; }
      else if (col === "ded" || col === "prev") { dsum += Math.abs(inf.amounts[j].value); nd++; }
      else if (col !== "") other = true;
    }
    if (other || g < 0 || p < 0 || nd === 0) continue;
    const gv = inf.amounts[g].value, pv = inf.amounts[p].value;
    if (pv <= 0 || gv <= pv || Math.abs(gv - dsum - pv) >= 0.015) continue;
    chainPairs.push(pv);
    chainPairs.push(gv);
    for (const c of all) if (Math.abs(c.value - gv) < 0.005) c.score -= 2;
  }
  // "sum of the others": an amount equals the sum of the amounts on keyword-free lines
  const plain: Candidate[] = [];
  let plainTotal = 0;
  for (const c of all) if (c.method === "largest") { plain.push(c); plainTotal += c.value; }
  if (plain.length >= 2) {
    for (const c of all) {
      if (c.method === "keyword-next-line" || c.value === 0) continue;
      const inPlain = c.method === "largest" || c.method === "sum-check";
      if (inPlain && plain.length < 3) continue;
      const others = inPlain ? plainTotal - c.value : plainTotal;
      if (Math.abs(others - c.value) >= 0.015) continue;
      if (inPlain && plain.length === 3) {
        // exactly two parts: gross = Skonto + net (small part <= 5 %) -> the net part is the payment
        const parts: Candidate[] = [];
        for (const p of plain) if (p !== c) parts.push(p);
        const big = Math.abs(parts[0].value) >= Math.abs(parts[1].value) ? parts[0] : parts[1];
        const small = big === parts[0] ? parts[1] : parts[0];
        if (Math.abs(small.value) <= 0.05 * Math.abs(c.value)) {
          big.score += 2;
          big.confirmed = true;
          big.method = "sum-check";
          continue;
        }
      }
      c.score += 2;
      c.confirmed = true;
      if (c.method === "largest") c.method = "sum-check";
    }
  }
  deductionChain(all, infos, candAt, chainPairs);
  nettingChain(infos, candAt, chainPairs);
  // a total that equals the sum of several payment lines ("Zahlbetrag" per invoice, then "Gesamt") is the grand total
  {
    const payVals: number[] = [];
    const payLines: number[] = [];
    for (const c of all) {
      if (!c.label.payment || !c.ownLabel || c.copy || c.value <= 0 || c.label.neg || payLines.indexOf(c.lineIdx) >= 0) continue;
      payVals.push(c.value);
      payLines.push(c.lineIdx);
      if (payVals.length > 200) break;
    }
    if (payVals.length >= 2 && payVals.length <= 200) {
      for (const c of all) {
        if (!c.label.strong || c.value <= 0 || c.copy) continue;
        let sum = 0, parts = 0;
        for (let q = 0; q < payVals.length; q++) if (payLines[q] !== c.lineIdx && payLines[q] < c.lineIdx) { sum += payVals[q]; parts++; }
        if (parts >= 2 && Math.abs(sum - c.value) < 0.015) {
          c.score += 2.5;
          c.confirmed = true;
          for (const d of all) if (d !== c && d.label.payment && d.lineIdx < c.lineIdx && Math.abs(d.value - c.value) >= 0.005) d.score -= 1;
        }
      }
    }
  }
  // two different strong lines naming the same value confirm each other
  const strongLines = new Map<number, number[]>();
  for (const c of all) {
    if (!(c.label.strong || c.method === "keyword-next-line") || c.label.neg || c.copy || c.value === 0) continue;
    const key = Math.round(c.value * 100);
    let arr = strongLines.get(key);
    if (!arr) { arr = []; strongLines.set(key, arr); }
    if (arr.indexOf(c.lineIdx) < 0) arr.push(c.lineIdx);
  }
  for (const c of all) {
    if (!(c.label.strong || c.method === "keyword-next-line") || c.label.neg || c.copy || c.value === 0) continue;
    const arr = strongLines.get(Math.round(c.value * 100));
    if (!arr || arr.length > 3) continue; // a value repeated on many rows is a per-invoice amount, not a confirmation
    for (const li of arr) {
      if (li === c.lineIdx) continue;
      if (Math.abs(li - c.lineIdx) <= 1 && c.method === "keyword-next-line") continue;
      c.score += 1;
      break;
    }
  }
  // magnitude: bigger amounts get a small bonus (totals are larger than line items)
  let maxAbs = 0;
  for (const c of all) maxAbs = Math.max(maxAbs, Math.abs(c.value));
  for (const c of all) if (maxAbs > 0) c.score += (Math.abs(c.value) / maxAbs) * 1.0;
  all.sort((a, b) => (b.score - a.score) || (b.lineIdx - a.lineIdx));
  // the chosen amount is the gross of exactly one netting chain (box, single row, chain of lines): take its payment
  // (not when an invoice copy won: that stays a manual check)
  if (all.length > 0 && !all[0].copy) {
    let pv = -1, many = false;
    for (let q = 0; q + 1 < chainPairs.length; q += 2) {
      if (Math.abs(chainPairs[q + 1] - all[0].value) >= 0.005) continue;
      if (pv < 0) pv = chainPairs[q];
      else if (Math.abs(chainPairs[q] - pv) >= 0.005) many = true;
    }
    if (pv > 0 && !many) {
      for (const c of all) if (!c.copy && Math.abs(c.value - pv) < 0.005) { all.splice(all.indexOf(c), 1); all.unshift(c); break; }
    }
  }
  // (E) one explicitly labelled transfer amount ("Überweisungsbetrag", "Auszahlungsbetrag", "Zahlbetrag") beats a computed
  // total when it comes after the total or is itself a total ("Zahlbetrag gesamt") or ends a netting chain, and the
  // difference is explained by deductions (chain, one deduction amount, a percentage)
  let transferValue = -1;
  let promoted: Candidate | null = null;
  // the single explicit transfer amount (also when a summed "Summe Zahlbetrag" line names another value)
  let xcT: Candidate | null = null;
  const dedL = deductionLines(infos);
  {
    let xc: Candidate | null = null, many = false;
    let xe: Candidate | null = null, manyE = false;
    for (const c of all) {
      if (!isTransferCand(c, infos)) continue;
      if (xc === null) xc = c;
      else if (Math.abs(c.value - xc.value) >= 0.005) many = true;
      if (summedTransferLabel(c, infos)) continue;
      if (xe === null) xe = c;
      else if (Math.abs(c.value - xe.value) >= 0.005) manyE = true;
    }
    if (xc !== null && !many) xcT = xc;
    else if (xe !== null && !manyE) xcT = xe;
    // the first amount of a row ("Überweisungsbetrag   3.500,00   3.454,00") labels the row, it is no single explicit amount
    if (xcT !== null && xcT.pos !== infos[xcT.lineIdx].amounts.length - 1) xcT = null;
    if (xc !== null && !many) {
      transferValue = xc.value;
      const top = all[0];
      const lbl = labelOf(xc, infos);
      let reconciled = xc.confirmed;
      if (!reconciled && top.value > xc.value) {
        for (const d of all) {
          if (!((d.label.ded && !d.label.payment) || d.col === "ded" || d.col === "prev") || d.value === 0 || d.copy) continue;
          if (Math.abs(top.value - Math.abs(d.value) - xc.value) < 0.015) { reconciled = true; break; }
        }
        for (const inf of infos) for (const pc of inf.pcts) if (Math.abs(top.value * (1 - pc / 100) - xc.value) < 0.015) reconciled = true;
      }
      if (reconciled && Math.abs(top.value - xc.value) >= 0.005 && !FUTURE_WORD.test(lbl) && !(top.label.payment && top.confirmed) &&
        (xc.confirmed || xc.lineIdx > top.lineIdx || TOTAL_WORD.test(lbl))) {
        all.splice(all.indexOf(xc), 1);
        all.unshift(xc);
        promoted = xc;
      }
    }
    // the transfer amount is the computed total minus deduction lines printed anywhere (fee and VAT on the fee after the
    // table, Delkredere and bonus on a later page, deductions in a header box): it wins, wherever its label stands
    if (promoted === null && xcT !== null && all[0] !== xcT && !xcT.copy && !FUTURE_WORD.test(labelOf(xcT, infos)) && deductionsExplain(all[0].value - xcT.value, dedL)) {
      transferValue = xcT.value;
      all.splice(all.indexOf(xcT), 1);
      all.unshift(xcT);
      promoted = xcT;
    }
  }
  // (e) the chosen total is not a payment, but a payment-worded line names a different amount:
  // uncertain; suggest that payment when it is the only one and looks like the total minus deductions
  let conflict = "";
  if (all.length > 0 && !all[0].label.payment && all[0].col !== "pay") {
    const top = all[0];
    let paySum = 0, other: Candidate | null = null, distinct = 0;
    const seenPay = new Map<number, boolean>();
    for (const c of all) {
      if (!c.label.payment || !c.ownLabel || c.copy || c.value <= 0 || c.label.neg) continue;
      if (c.method === "keyword-next-line" && c.line.indexOf(" | ") > 45) {
        // a sentence, not a label – unless it runs into the amount: "... überweisen wir Ihnen in Höhe von" / "3.454,00 EUR"
        const lbl = c.line.substring(0, c.line.indexOf(" | "));
        if (!/(?:\bvon|\bhöhe|\bbetrag|\bsumme)\s*:?\s*$/i.test(lbl) || hasWords(infos[c.lineIdx].text)) continue;
      }
      const key = Math.round(c.value * 100);
      if (seenPay.has(key)) continue;
      seenPay.set(key, true);
      distinct++;
      paySum += c.value;
      if (Math.abs(c.value - top.value) >= 0.005 && other === null) other = c;
    }
    if (other !== null && Math.abs(paySum - top.value) >= 0.015) {
      conflict = "payment line says " + other.amount + ", total says " + top.amount;
      if (distinct === 1 && other.value < top.value && other.value >= 0.9 * top.value) {
        all.splice(all.indexOf(other), 1);
        all.unshift(other);
      }
    }
  }
  const best = all.length > 0 ? all[0] : null;
  // an explicit transfer amount that differs from the chosen amount by more than the printed deductions: the computed
  // total is not trusted ("Überweisungsbetrag 11.200,00" in the header, table total 11.370,44, no matching deductions)
  let transferMismatch = "";
  if (best !== null && xcT !== null && best !== xcT && Math.abs(best.value - xcT.value) >= 0.005 && !FUTURE_WORD.test(labelOf(xcT, infos))) {
    let explained = xcT.confirmed && best.value > xcT.value;
    for (const inf of infos) for (const pc of inf.pcts) if (Math.abs(best.value * (1 - pc / 100) - xcT.value) < 0.015) explained = true;
    // the labelled amount is an intermediate step ("Zahlbetrag lt. Rechnung 1.190,00 / abzüglich Skonto -23,80 /
    // Überweisung 1.166,20", "Erstattungsbetrag 2.116,00 / abzüglich Selbstbeteiligung 300,00 / Wir überweisen 1.816,00"):
    // deduction lines between it and the chosen amount below explain the rest
    if (!explained && best.value < xcT.value && best.lineIdx > xcT.lineIdx) {
      if (deductionsExplain(xcT.value - best.value, deductionLines(infos.slice(xcT.lineIdx + 1, best.lineIdx)))) explained = true;
      for (const inf of infos) for (const pc of inf.pcts) if (Math.abs(xcT.value * (1 - pc / 100) - best.value) < 0.015) explained = true;
    }
    if (!explained && !deductionsExplain(best.value - xcT.value, dedL)) transferMismatch = "transfer amount " + xcT.amount + " differs from " + best.amount;
  }
  const cur = chooseCurrency(best, infos, best !== null ? infos[best.lineIdx].text : "");
  const out: AmountPick = { best: best, candidates: all.slice(0, 8), currency: cur.code, confidence: "low", reason: "" };
  if (best === null) return out;

  // ---- confidence: rule quality + distance to the next different amount + absolute score floors
  const text = normLines.join("\n");
  const avisTitle = doc.kind === "advice";
  const bestTransfer = transferValue >= 0 && Math.abs(best.value - transferValue) < 0.005;
  // one amount value in the whole document (outside copies and quoted mails)
  let singleValue = true;
  let firstValue = -1;
  for (const inf of infos) {
    if (inf.copy || inf.quoted) continue;
    for (const a of inf.amounts) {
      if (a.value <= 0) continue;
      if (firstValue < 0) firstValue = a.value;
      else if (Math.abs(a.value - firstValue) >= 0.005) singleValue = false;
    }
  }
  if (singleValue && integerCurrencyAmount(doc.ownText)) singleValue = false;
  let anyPct = false;
  for (const inf of infos) if (inf.pcts.length > 0) anyPct = true;
  let margin = 99;
  let runnerUp: Candidate | null = null;
  for (const c of all) {
    if (Math.abs(c.value - best.value) < 0.005) continue;
    let chained = false;
    for (let q = 0; q + 1 < chainPairs.length; q += 2) if (Math.abs(chainPairs[q] - best.value) < 0.005 && Math.abs(chainPairs[q + 1] - c.value) < 0.005) chained = true;
    if (chained) continue;
    margin = best.score - c.score;
    runnerUp = c;
    break;
  }
  const m = best.method;
  let weakAlone = false;
  if (m === "keyword-weak" && !best.confirmed) {
    for (const c of all) if (Math.abs(c.value - best.value) >= 0.005 && c.value !== 0 && !c.label.neg && !c.label.ded && c.col === "" && !c.copy) { weakAlone = true; break; }
  }
  const strongRule = m === "keyword" || m === "keyword-next-line" || m === "column-sum" || m === "deduction" || (m === "column-header" && best.confirmed);
  let conf = "low";
  let reason = "";
  if (promoted !== null) conf = "high";
  else if (strongRule && margin >= 1.5 && best.score >= 4) conf = "high";
  else if (margin >= 0.75 && best.score >= 2.5 && m !== "largest" && m !== "sum-check" && !weakAlone) conf = "medium";
  else if (m === "sum-check" && avisTitle && best.col === "gross" && infos[best.lineIdx].grossPay && best.pos === infos[best.lineIdx].amounts.length - 1 && margin >= 0.75 && best.score >= 2.5) conf = "medium";
  // the only explicitly labelled transfer amount, close to a total or subtotal that is not worded as a payment
  else if (bestTransfer && runnerUp !== null && !runnerUp.label.payment && runnerUp.col !== "pay" && best.score >= 4) conf = best.confirmed ? "high" : "medium";
  // one amount in an advice or in a payer's letter, no netting words: nothing to confuse it with
  else if (singleValue && (avisTitle || doc.payer) && !anyPct && !best.label.neg && !NETTING_TEXT.test(doc.ownText)) conf = "medium";
  else if (m === "largest") reason = "no label, amount chosen by size";
  else if (m === "sum-check") reason = "amount only backed by a sum check";
  else if (weakAlone) reason = "only a weak label (Betrag/Zahlung)";
  else if (runnerUp !== null && margin < 0.75) reason = "close runner-up " + runnerUp.amount;
  else reason = "weak signals";

  const reasons: string[] = [];
  if (reason !== "") reasons.push(reason);
  // document check: a payment advice talks about paying; other document types (title, strong phrases) do not count
  if (doc.kind === "other") { conf = "low"; reasons.unshift(doc.why); }
  else if (doc.kind !== "advice" && !PAYMENT_MARKER.test(text) && !PAYMENT_MARKER.test(text.replace(/\s+/g, "")) && !(doc.foreignPayer && FOREIGN_PAYMENT_MARKER.test(text))) { conf = "low"; reasons.unshift("no payment wording - not a payment advice?"); }
  if (best.copy) { conf = "low"; reasons.push(infos[best.lineIdx].quoted ? "amount from the quoted e-mail" : "amount from an attached invoice copy"); }
  else {
    // a total right after a VAT line looks like an invoice – unless it is the only total (self-billing credit note)
    let otherTotal = false;
    for (const c of all) if (c.label.strong && !c.label.neg && Math.abs(c.value - best.value) >= 0.005 && Math.abs(c.lineIdx - best.lineIdx) > 3) { otherTotal = true; break; }
    for (let k = Math.max(0, best.lineIdx - 3); k < best.lineIdx && otherTotal; k++) {
      // VAT on a fee that is deducted ("19 % USt auf Regulierungsgebühr 4,75") is a deduction line, not an invoice's VAT
      const kl = infos[k].amounts.length;
      if (kl > 0 && VAT_LINE.test(infos[k].text) && !infos[k].header && !(infos[k].labels[kl - 1].ded && !infos[k].labels[kl - 1].payment)) { conf = "low"; reasons.push("total follows a VAT line - invoice?"); break; }
    }
  }
  if (best.risky) {
    // a separate labelled line with the same amount outside the table settles it
    let backed = false;
    for (const c of all) if (!c.risky && c.ownLabel && c.label.strong && !c.label.neg && Math.abs(c.value - best.value) < 0.005) backed = true;
    if (!backed) { conf = "low"; reasons.push("Skonto/Rest column on the right of the table"); }
  }
  // (d) another strong amount equals the best amount minus a deduction
  const dedValues: number[] = [];
  const pctValues: number[] = [];
  for (const d of all) {
    if (!((d.label.ded && !d.label.payment) || d.col === "ded" || d.col === "prev") || d.value === 0) continue;
    const v = Math.abs(d.value);
    let dup = false;
    for (const x of dedValues) if (Math.abs(x - v) < 0.005) dup = true;
    if (!dup && dedValues.length < 200) dedValues.push(v);
  }
  for (const inf of infos) for (const pc of inf.pcts) if (pctValues.indexOf(pc) < 0) pctValues.push(pc);
  let nearDed = false;
  for (const s of all) {
    if (nearDed) break;
    if (s.value <= 0 || s.value >= best.value - 0.005 || s.label.neg || !(s.label.strong || s.label.payment || s.method === "keyword-next-line")) continue;
    for (const v of dedValues) if (Math.abs(best.value - v - s.value) < 0.015) nearDed = true;
    for (const pc of pctValues) if (Math.abs(best.value * (1 - pc / 100) - s.value) < 0.015) nearDed = true;
  }
  let valueConfirmed = false;
  for (const c of all) if (c.confirmed && Math.abs(c.value - best.value) < 0.005) valueConfirmed = true;
  if (!nearDed && !valueConfirmed && best.value > 0) {
    // best = S + D with S >= 90 % of best and D another amount (deduction without a readable label)
    const vals: number[] = [];
    for (const c of all) if (c.value > 0 && !c.copy && vals.length < 400) vals.push(c.value);
    for (const sv of vals) {
      if (nearDed) break;
      if (sv >= best.value - 0.005 || sv < 0.9 * best.value) continue;
      for (const dv of vals) if (Math.abs(best.value - sv - dv) < 0.015) { nearDed = true; break; }
    }
  }
  if (nearDed) { conf = "low"; reasons.push("deduction near the total"); }
  else if (best.value > 0) {
    // the chosen amount looks like the deduction itself: total T - best = another amount U (best <= 10 % of T)
    const vals: number[] = [];
    for (const c of all) if (c.value > 0 && vals.length < 400) vals.push(c.value);
    let looksDed = false;
    for (const tv of vals) {
      if (looksDed) break;
      if (best.value > 0.1 * tv) continue;
      for (const uv of vals) if (Math.abs(tv - best.value - uv) < 0.015) { looksDed = true; break; }
    }
    if (looksDed) { conf = "low"; reasons.push("amount looks like a deduction"); }
  }
  if (conflict !== "") { conf = "low"; reasons.push(conflict); }
  else if (transferMismatch !== "") { conf = "low"; reasons.push(transferMismatch); }
  // a line labelled only with a payment noun ("Zahlung 46.609,50") names another amount than the chosen total
  if (conf !== "low" && !best.label.payment && best.col !== "pay") {
    for (const c of all) {
      if (c.copy || c.pos < 0 || !c.ownLabel || c.value <= 0 || Math.abs(c.value - best.value) < 0.005) continue;
      if (PAY_NOUN.test(labelOf(c, infos).trim())) { conf = "low"; reasons.push("payment line says " + c.amount); break; }
    }
  }
  // a bare table total in the payment column only counts credit notes listed below it ("Summe Gutschriften 238,00")
  const payCell = best.col === "pay" && !best.ownLabel;
  if (((!best.label.payment && best.col !== "pay") || payCell) && best.value > 0) {
    let dsum = 0, open = false;
    for (let k = best.lineIdx + 1; k <= best.lineIdx + 4 && k < infos.length; k++) {
      const inf = infos[k];
      if (inf.amounts.length !== 1 || !inf.labels[0].ded || inf.labels[0].payment) continue;
      if (payCell && !/gutschrift|credit note/i.test(inf.text)) continue;
      // a short deduction line ("abzüglich 2 % Skonto 71,40", "Skonto 26,00"), not a sentence
      if (inf.text.length - inf.amounts[0].text.length > 40) continue;
      dsum += Math.abs(inf.amounts[0].value);
      let found = false;
      for (const c of all) if (Math.abs(c.value - (best.value - dsum)) < 0.015) { found = true; break; }
      if (!found) open = true;
    }
    if (open) { conf = "low"; reasons.push("deduction below the total"); }
  }
  // credit notes in a block of their own (positive amounts) that the chosen total does not net: the payment is not printed
  if (!bestTransfer && best.value > 0 && conf !== "low") {
    const credits: number[] = [];
    let inSection = false;
    for (let i = 0; i < infos.length; i++) {
      const inf = infos[i];
      if (inf.text.length === 0) { inSection = false; continue; }
      if (inf.amounts.length === 0) {
        if (inf.header) { const hc = lineCells(inf.text); inSection = hc.length >= 2 && CREDIT_WORD.test(inf.text.substring(hc[0], hc[1])); }
        else if (inf.text.length <= 40) inSection = CREDIT_SECTION.test(inf.text);
        continue;
      }
      if (inf.copy || inf.quoted || i === best.lineIdx) continue;
      if (!inSection && !CREDIT_WORD.test(inf.text.substring(0, inf.amounts[0].index))) continue;
      const v = inf.amounts[inf.amounts.length - 1].value;
      if (v > 0 && credits.length < 50) credits.push(v);
    }
    if (credits.length > 0) {
      let csum = 0, cmax = 0;
      for (const v of credits) { csum += v; cmax = Math.max(cmax, v); }
      let netted = false;
      for (const c of all) {
        const d = c.value - best.value;
        if (Math.abs(d - cmax) < 0.015 || Math.abs(d - csum) < 0.015 || Math.abs(d - (csum - cmax)) < 0.015) { netted = true; break; }
      }
      if (!netted) { conf = "low"; reasons.push("credit note not netted in the total"); }
    }
  }
  // a later total adds further amounts to the chosen payment ("Zahlbetrag 980,00" of the first invoice, then "Summe 3.454,00")
  if (best.label.payment && conf !== "low") {
    for (const t of all) {
      if (t.lineIdx <= best.lineIdx || !t.label.strong || t.label.neg || t.copy || t.value <= best.value + 0.005) continue;
      let total = best.value, parts = 0, ded = false;
      for (let li = best.lineIdx + 1; li < t.lineIdx && li <= best.lineIdx + 12; li++) {
        const k = infos[li].amounts.length;
        if (infos[li].text.length === 0) { ded = true; break; } // only on the same page
        if (k === 0) continue;
        const col = infos[li].cols[k - 1];
        if (infos[li].labels[k - 1].ded || col === "ded" || col === "prev" || col === "rest" || col === "vat") ded = true;
        total += infos[li].amounts[k - 1].value;
        parts++;
      }
      if (parts >= 1 && !ded && Math.abs(total - t.value) < 0.015) { conf = "low"; reasons.push("total " + t.amount + " below includes the payment"); break; }
    }
  }
  // a payment sentence with an amount without decimals ("überwiesen haben wir 1.000 EUR"): that value is not read
  for (let i = 0; i < doc.quoteStart && conf !== "low"; i++) {
    const t = infos[i].text;
    if ((PAYMENT_KEYWORDS.test(t) || POST_PAYMENT.test(t)) && integerCurrencyAmount(t)) { conf = "low"; reasons.push("payment amount without decimals"); }
  }
  // (c) a payment label whose amount could not be read
  for (let i = 0; i < infos.length; i++) {
    const inf = infos[i];
    if (inf.amounts.length > 0 || inf.header) continue;
    const pm = PAYMENT_LABEL.exec(inf.text);
    if (!pm) continue;
    const tail = inf.text.substring(pm.index + pm[0].length).replace(CURRENCY_TOKEN, " ").replace(/\b(?:in|gesamt|total|insgesamt)\b/gi, " ");
    CURRENCY_TOKEN.lastIndex = 0;
    if (/[A-Za-zÄÖÜäöüß]{2,}/.test(tail)) continue;
    let found = false;
    for (let k = 1; k <= 2 && i + k < infos.length; k++) {
      const nx = infos[i + k];
      // a line with its own deduction/balance label ("Offener Saldo ... 12.500,00") is not the missing amount
      if (nx.amounts.length > 0 && !(nx.labels[0].neg && !nx.labels[0].payment && hasWords(nx.text.substring(0, nx.amounts[0].index)))) found = true;
    }
    if (!found) { conf = "low"; reasons.push("payment label without readable amount"); break; }
  }
  // (f) a second payment-labelled amount that only the size/position bonuses separate from the best: ambiguous;
  // a bigger payment total ("Gesamtzahlbetrag") that lost against one invoice payment: also ambiguous
  if (best.label.payment && conf !== "low") {
    for (const c of all) {
      if (c === best || !c.label.payment || c.label.ded || !c.ownLabel || c.copy || c.value <= 0 || Math.abs(c.value - best.value) < 0.005) continue;
      const biggerTotal = c.value > best.value && c.label.strong && c.lineIdx !== best.lineIdx && infos[c.lineIdx].amounts.length === 1 && /gesamt|total|summe|insgesamt/i.test(c.line);
      if ((!best.confirmed && best.score - c.score < 1.5) || biggerTotal) { conf = "low"; reasons.push("second payment amount " + c.amount); }
      break;
    }
  }
  // two payment sentences of the writer name different amounts, none is an earlier payment and the largest is not their sum
  // ("für Rechnung A haben wir 1.190,00 EUR überwiesen. Für Rechnung B haben wir 2.264,00 EUR überwiesen.")
  if (curPayVals.length >= 2 && conf !== "low") {
    let mx = 0, tot = 0;
    for (const x of curPayVals) { tot += x; mx = Math.max(mx, x); }
    if (Math.abs(mx - (tot - mx)) >= 0.015 && Math.abs(best.value - tot) >= 0.015) { conf = "low"; reasons.push("payment sentences with different amounts"); }
  }
  // two bare sum lines ("Bezahlte Rechnungen" ... 3.454,00 / "Offene Rechnungen" ... 19.440,00): which one is paid is unclear
  if (m === "column-sum" && !best.ownLabel && conf !== "low") {
    for (const c of all) if (c.method === "column-sum" && !c.ownLabel && c.lineIdx !== best.lineIdx && Math.abs(c.value - best.value) >= 0.005) { conf = "low"; reasons.push("several unlabelled sums"); break; }
  }
  // the gross column of a table that has a payment column: the payment cell is missing or unreadable
  if (best.col === "gross" && infos[best.lineIdx].payCol && conf !== "low") { conf = "low"; reasons.push("gross column chosen, payment column empty"); }
  // a zero amount is trusted only under a clean payment label ("Zahlbetrag 0,00" after netting)
  if (best.value === 0 && conf !== "low" && (!best.label.payment || best.label.neg || best.label.ded)) { conf = "low"; reasons.push("amount is zero"); }
  if (cur.competing && conf !== "low") { conf = downgrade(conf); if (conf === "low") reasons.push("several currencies (" + cur.codes + ")"); }
  out.confidence = conf;
  if (conf === "low") {
    if (reasons.length === 0) reasons.push("weak signals");
    out.reason = reasons.slice(0, 2).join("; ");
  }
  return out;
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------
const MAX_TEXT_CHARS = 100000;
// file name of an advice inside a mail container (preferred over the other PDFs of the mail)
const ADVICE_FILE_NAME = /zahlungsavis|überweisungsavis|ueberweisungsavis|payment.?advice|remittance|(?:^|[^a-zäöüß])avis(?:[^a-zäöüß]|$)/i;

// Result of the extraction step. encrypted: the PDF cannot be decrypted (cryptError says why);
// incomplete: reasons why the text may be partial; ocr: an OCR text layer makes up most of the text;
// signedChange: a signed PDF was changed after its last signature (what changed), "" otherwise.
interface ExtractInfo { lines: string[]; pages: number; warnings: string[]; encrypted: boolean; cryptError: string; incomplete: string[]; ocr: boolean; signedChange: string }

function extractPdf(bytes: Uint8Array): ExtractInfo {
  const s = bytesToLatin1(bytes, 0, bytes.length);
  const doc = new PdfDoc(s);
  doc.load();
  const info: ExtractInfo = { lines: [], pages: 0, warnings: doc.warnings, encrypted: false, cryptError: "", incomplete: doc.incomplete, ocr: false, signedChange: "" };
  if (doc.cryptStatus !== "none" && doc.cryptStatus !== "decrypted") {
    info.encrypted = true;
    info.cryptError = doc.cryptStatus === "password" ? "PDF is password protected - cannot be read"
      : doc.cryptStatus === "certificate" ? "PDF is encrypted with a certificate - cannot be read"
      : doc.cryptStatus === "protected" ? "protected PDF - cannot be read"
      : "PDF is encrypted with an unsupported method (" + doc.cryptDetail + ") - cannot be read";
    return info;
  }
  info.signedChange = doc.changedAfterSigning();
  const pages = doc.pages();
  const interp = new ContentInterpreter(doc);
  const boxes: number[][] = [];
  for (let i = 0; i < pages.length; i++) {
    boxes.push(pages[i].box);
    if (Date.now() > runDeadline) {
      doc.warnings.push("time budget exhausted, text truncated");
      doc.flagIncomplete("time budget exhausted");
      break;
    }
    interp.beginPage(pages[i].box);
    try {
      const content = doc.pageContent(pages[i].dict);
      interp.runPage(content, pages[i].resources, i);
      interp.runAnnotations(pages[i].dict, pages[i].resources, i);
    } catch (e) {
      doc.warnings.push("page " + (i + 1) + ": " + String(e));
      doc.flagIncomplete("page " + (i + 1) + " could not be read");
    }
    interp.endPage();
  }
  info.lines = assembleLines(interp.finishItems(boxes));
  info.pages = pages.length;
  // glyphs without a Unicode mapping: their text (possibly the amount) is lost
  if (interp.glyphsNoUni >= 3 && interp.glyphsNoUni > 0.03 * interp.glyphsTotal) doc.flagIncomplete(interp.glyphsNoUni + " of " + interp.glyphsTotal + " glyphs without Unicode mapping");
  // OCR text layer: invisible / OCR-font text, text under a page image, or an OCR producer on image pages
  let ocrGlyphs = interp.glyphsOcr + interp.glyphsCovered;
  if (interp.pagesWithImage > 0 && /tesseract|ocrmypdf|abbyy|finereader|readiris|omnipage|paper capture|scansoft|\bocr\b/i.test(doc.producerInfo())) ocrGlyphs += interp.glyphsOnImagePages;
  info.ocr = interp.glyphsTotal > 0 && ocrGlyphs * 2 > interp.glyphsTotal;
  const front: string[] = [];
  if (info.signedChange !== "") front.push("PDF changed after signing (" + info.signedChange + ")");
  if (doc.cryptStatus === "decrypted") front.push("decrypted (permissions-only encryption)");
  if (info.ocr) front.push("OCR text layer (" + Math.round((100 * ocrGlyphs) / interp.glyphsTotal) + " % of the text)");
  for (const r of doc.incomplete) front.push("incomplete: " + r);
  info.warnings = front.concat(doc.warnings);
  return info;
}

function emptyResult(): AvisResult {
  return { ok: false, amount: "", amountNumber: 0, currency: "", line: "", method: "none", confidence: "low", candidates: [], pages: 0, text: "", textLength: 0, warnings: "", error: "" };
}

// one analysed PDF: the result and the score of the chosen amount (-1 = none)
interface PdfOutcome { res: AvisResult; score: number }

function analyzePdf(bytes: Uint8Array, extraKeywords: string): PdfOutcome {
  // text extraction + amount heuristic for one PDF (bytes start with or contain "%PDF")
  const res = emptyResult();
  const out: PdfOutcome = { res: res, score: -1 };
  try {
    const ex = extractPdf(bytes);
    res.pages = ex.pages;
    res.warnings = ex.warnings.slice(0, 20).join(" | ");
    if (ex.encrypted) { res.error = ex.cryptError; return out; }
    const text = ex.lines.join("\n");
    res.textLength = text.length;
    res.text = text.length > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    if (text.replace(/\s/g, "").length === 0) {
      // the time budget ran out before any text was read: say so instead of "scanned PDF"
      res.error = ex.pages === 0 ? "no pages found" : ex.incomplete.indexOf("time budget exhausted") >= 0 ? "PDF read incompletely (time budget exhausted)" : "no text layer found (scanned PDF?)";
      return out;
    }
    const pick = pickAmount(ex.lines, extraKeywords);
    res.currency = pick.currency;
    res.candidates = [];
    for (const c of pick.candidates) res.candidates.push(c.amount + " | " + c.score.toFixed(2) + " | " + c.method + " | " + c.line.substring(0, 120));
    if (pick.best) {
      res.ok = true;
      res.amount = pick.best.amount;
      res.amountNumber = Math.round(pick.best.value * 100) / 100;
      res.line = pick.best.line;
      res.method = pick.best.method;
      out.score = pick.best.score;
      // confidence comes from pickAmount (rule quality, margin, score floors, safety nets);
      // a low result always carries a short reason for the manual-check mail
      res.confidence = pick.confidence;
      if (res.confidence === "low") res.error = "uncertain: " + (pick.reason || "weak signals");
    } else {
      res.error = "no amount pattern found";
    }
    // ---- extraction quality (extraction part): partial or OCR text never keeps high/medium ----
    if (res.ok && (ex.ocr || ex.incomplete.length > 0)) {
      const why: string[] = [];
      if (ex.ocr) why.push("OCR text layer");
      if (ex.incomplete.length > 0) why.push("PDF read incompletely (" + ex.incomplete[0] + ")");
      const prev = res.error.indexOf("uncertain: ") === 0 ? res.error.substring(11) : res.error;
      res.confidence = "low";
      res.error = "uncertain: " + why.join("; ") + (prev !== "" ? "; " + prev : "");
    }
    // ---- end extraction quality ----
    // ---- signed PDF changed after its last signature: the amount read may not be the signed one ----
    if (res.ok && ex.signedChange !== "") {
      const prev = res.error.indexOf("uncertain: ") === 0 ? res.error.substring(11) : res.error;
      res.confidence = "low";
      res.error = "uncertain: PDF changed after signing" + (prev !== "" ? "; " + prev : "");
    }
    return out;
  } catch (e) {
    res.error = "exception: " + String(e);
    return out;
  }
}

function outcomeRank(o: PdfOutcome): number {
  // ok first, then confidence, then score (used to pick the best PDF of a mail)
  const conf = o.res.confidence === "high" ? 2 : o.res.confidence === "medium" ? 1 : 0;
  return (o.res.ok ? 1e9 : 0) + conf * 1e7 + Math.max(-1, Math.min(o.score, 999999));
}

function mailResult(mail: MailScan, inputLength: number, extraKeywords: string): AvisResult {
  // result for a mail container (smime.p7m, .eml): pick the PDF and analyse it
  if (mail.pdfs.length === 0) {
    const res = emptyResult();
    res.error = mail.encrypted ? "S/MIME encrypted mail - cannot be read"
      : mail.rpmsg ? "protected mail (Microsoft Purview) - cannot be read"
      : mail.signed ? "signed mail contains no PDF"
      : "not a PDF (header missing, " + inputLength + " bytes)";
    return res;
  }
  // the same file attached twice counts once
  const pdfs: MailPdf[] = [];
  for (const p of mail.pdfs) {
    let dup = false;
    for (const q of pdfs) if (q.data.length === p.data.length && bytesEqual(q.data, p.data, p.data.length)) dup = true;
    if (!dup) pdfs.push({ name: p.name !== "" ? p.name : "(unnamed)", data: p.data });
  }
  // a file named like an advice wins; otherwise every PDF is analysed and the best result is kept
  let cands: MailPdf[] = [];
  // ("Zahlungsavis_4711.pdf", "Avis-4711.pdf", "Remittance.pdf"; not "Lieferavis", "Versandavis", "Avisierung", "Davis")
  for (const p of pdfs) if (ADVICE_FILE_NAME.test(p.name)) cands.push(p);
  if (cands.length === 0) cands = pdfs;
  const MAX_PDFS = 6;
  const outcomes: PdfOutcome[] = [];
  let best = -1;
  for (let i = 0; i < cands.length && i < MAX_PDFS; i++) {
    if (i > 0 && Date.now() > runDeadline) break;
    totalDecoded = 0;
    const o = analyzePdf(cands[i].data, extraKeywords);
    outcomes.push(o);
    if (best < 0 || outcomeRank(o) > outcomeRank(outcomes[best])) best = i;
  }
  const res = outcomes[best].res;
  const notes: string[] = [(mail.signed ? "from signed mail: " : "from mail: ") + cands[best].name];
  if (outcomes.length > 1) {
    let names = "";
    for (let i = 0; i < outcomes.length; i++) names += (i > 0 ? ", " : "") + cands[i].name;
    notes.push(outcomes.length + " PDFs checked (" + names + ")");
  }
  if (cands.length > outcomes.length) notes.push("only " + outcomes.length + " of " + cands.length + " PDFs checked");
  if (mail.extraPdfs > 0) notes.push("only the first " + mail.pdfs.length + " of " + (mail.pdfs.length + mail.extraPdfs) + " PDFs read");
  // two PDFs with different trusted amounts: which one is the payment is not clear
  if (res.ok && res.confidence !== "low") {
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i].res;
      if (i === best || !o.ok || o.confidence === "low") continue;
      if (o.amountNumber === res.amountNumber && o.currency === res.currency) continue;
      const prev = res.error.indexOf("uncertain: ") === 0 ? res.error.substring(11) : res.error;
      res.confidence = "low";
      res.error = "uncertain: several PDFs in the mail with different amounts (" + cands[i].name + ": " + o.amount + ")" + (prev !== "" ? "; " + prev : "");
      break;
    }
  }
  res.warnings = notes.join(" | ") + (res.warnings !== "" ? " | " + res.warnings : "");
  return res;
}

function main(workbook: ExcelScript.Workbook, pdfBase64: string, extraKeywords?: string): AvisResult {
  // Office Script entry point.
  // @param pdfBase64  Base64 content of the PDF (e.g. contentBytes of "Get attachment (V2)"); also accepted:
  //                   the content of an S/MIME "smime.p7m" attachment (signed mail) or of an .eml file -
  //                   the PDF inside is used (the signature is not verified)
  // @param extraKeywords  optional, comma separated extra keywords that mark the total line ("Auszahlung, Überweisungssumme"); may be ""
  const res = emptyResult();
  totalDecoded = 0;
  runDeadline = Date.now() + 90000; // stay well below the 120 s Power Automate limit
  try {
    if (!pdfBase64 || pdfBase64.length < 16) { res.error = "no PDF content passed"; return res; }
    const inp = decodeInput(pdfBase64);
    const bytes = inp.bytes;
    if (bytes.length < 8 || bytesToLatin1(bytes, 0, 4) !== "%PDF") {
      // not a PDF: a mail container (smime.p7m: clear-signed MIME text or CMS SignedData; encrypted S/MIME; .rpmsg)?
      const mail = unwrapMail(bytes);
      if (mail.container) return inputNote(mailResult(mail, bytes.length, extraKeywords || ""), inp);
      totalDecoded = 0;
      // some mail systems prefix junk before %PDF – look for the header anyway
      const probe = bytesToLatin1(bytes, 0, Math.min(bytes.length, 2048));
      if (probe.indexOf("%PDF") < 0) {
        res.error = "not a PDF (header missing, " + bytes.length + " bytes; input " + describeInput(pdfBase64) + ")";
        return res;
      }
    }
    return inputNote(analyzePdf(bytes, extraKeywords || "").res, inp);
  } catch (e) {
    res.error = "exception: " + String(e);
    return res;
  }
}

function inputNote(res: AvisResult, inp: InputBytes): AvisResult {
  // the flow passed the file as text instead of Base64: say so; with lost bytes the amount is never trusted
  if (inp.form !== "text") return res;
  res.warnings = "PDF arrived as text instead of Base64" + (inp.damaged > 0 ? " (" + inp.damaged + " characters lost)" : "")
    + (res.warnings !== "" ? " | " + res.warnings : "");
  if (inp.damaged === 0) return res;
  if (res.ok) {
    const prev = res.error.indexOf("uncertain: ") === 0 ? res.error.substring(11) : res.error;
    res.confidence = "low";
    res.error = "uncertain: PDF arrived as text instead of Base64 - parts may be damaged" + (prev !== "" ? "; " + prev : "");
  } else {
    res.error = "PDF arrived as text instead of Base64 - content damaged (" + res.error + ")";
  }
  return res;
}
