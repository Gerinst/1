// =====================================================================
//  Avis PDF Amount – Office Script (Power Automate "Run script")
//  Extracts the embedded text of a text-based PDF and finds the payment /
//  total amount. Pure TypeScript, no libraries, no network.
//  Pipeline: Base64 -> bytes -> PDF objects (incl. object streams) ->
//  page tree -> content streams (FlateDecode, LZW, A85, AHx, RL) ->
//  font decoding (WinAnsi/MacRoman/Standard/Differences, ToUnicode,
//  Identity-H, embedded TrueType cmap) -> lines -> amount heuristic.
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
  // tolerate a JSON file object {"$content-type":"...","$content":"..."} or a data URI
  const m = /"\$content"\s*:\s*"([^"]*)"/.exec(s);
  if (m) s = m[1];
  const comma = s.indexOf(",");
  if (s.substring(0, 5) === "data:" && comma > 0) s = s.substring(comma + 1);
  const lookup = new Int16Array(256);
  for (let i = 0; i < 256; i++) lookup[i] = -1;
  for (let i = 0; i < 64; i++) lookup[B64_ALPHABET.charCodeAt(i)] = i;
  lookup[45] = 62; // '-' (url-safe)
  lookup[95] = 63; // '_'
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
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

/** bytes -> "latin1" string (one char per byte) */
function bytesToLatin1(b: Uint8Array, start: number, end: number): string {
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
  pos: number;
  bitBuf = 0;
  bitCnt = 0;
  eof = false;
  constructor(public data: Uint8Array, pos: number) {
    this.pos = pos;
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

class ByteSink {
  buf: Uint8Array;
  len = 0;
  constructor(cap: number) {
    this.buf = new Uint8Array(Math.min(Math.max(cap, 1024), MAX_STREAM_BYTES));
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

/** inflate raw deflate data starting at `pos`; returns [output, errorFlag] */
function inflateRaw(data: Uint8Array, pos: number): Uint8Array {
  const br = new BitReader(data, pos);
  const out = new ByteSink(data.length * 4);
  let last = 0;
  outer: while (!last) {
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
        if (br.pos >= data.length) break outer;
        out.buf[out.len++] = data[br.pos++];
      }
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
        if (sym < 0) break outer;
        if (sym < 16) {
          ll[idx++] = sym;
        } else {
          let len = 0, rep = 0;
          if (sym === 16) {
            if (idx === 0) break outer;
            len = ll[idx - 1];
            rep = 3 + br.bits(2);
          } else if (sym === 17) {
            rep = 3 + br.bits(3);
          } else {
            rep = 11 + br.bits(7);
          }
          if (idx + rep > nlen + ndist) break outer;
          while (rep-- > 0) ll[idx++] = len;
        }
      }
      if (br.eof) break;
      lit = huffBuild(ll.subarray(0, nlen), nlen);
      dist = huffBuild(ll.subarray(nlen, nlen + ndist), ndist);
    } else {
      break; // invalid block type
    }
    // decode compressed block
    for (;;) {
      let sym = huffDecode(br, lit);
      if (sym < 0) break outer;
      if (sym < 256) {
        out.push(sym);
      } else if (sym === 256) {
        break;
      } else {
        sym -= 257;
        if (sym >= 29) break outer;
        const eb = br.bits(LEN_EXTRA[sym]);
        if (eb < 0) break outer;
        const len = LEN_BASE[sym] + eb;
        const ds = huffDecode(br, dist);
        if (ds < 0 || ds >= 30) break outer;
        const de = br.bits(DIST_EXTRA[ds]);
        if (de < 0) break outer;
        const d = DIST_BASE[ds] + de;
        if (d > out.len) break outer;
        out.ensure(len);
        let src = out.len - d;
        for (let i = 0; i < len; i++) out.buf[out.len++] = out.buf[src++];
      }
    }
  }
  return out.result();
}

function inflate(data: Uint8Array): Uint8Array {
  let p = 0;
  // skip leading whitespace/garbage some producers emit before the zlib header
  while (p < data.length && (data[p] === 0x0a || data[p] === 0x0d || data[p] === 0x20 || data[p] === 0x09)) p++;
  if (p + 2 <= data.length) {
    const cmf = data[p], flg = data[p + 1];
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
      let start = p + 2;
      if (flg & 0x20) start += 4; // preset dictionary id
      const r = inflateRaw(data, start);
      if (r.length > 0) return r;
    }
  }
  const raw = inflateRaw(data, p);
  if (raw.length > 0) return raw;
  return inflateRaw(data, p + 1); // last resort: one byte of junk
}

// ---------------------------------------------------------------------
// Predictors (PNG / TIFF) for FlateDecode & LZWDecode
// ---------------------------------------------------------------------
function applyPredictor(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
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

// ---------------------------------------------------------------------
// Other filters
// ---------------------------------------------------------------------
function asciiHexDecode(data: Uint8Array): Uint8Array {
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

function lzwDecode(data: Uint8Array, earlyChange: number): Uint8Array {
  const out = new ByteSink(data.length * 3);
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([]); // 256 = clear table
    dict.push([]); // 257 = end of data
  };
  reset();
  let codeLen = 9;
  let prev: number[] | null = null;
  let bitBuf = 0, bitCnt = 0, pos = 0;
  while (true) {
    while (bitCnt < codeLen) {
      if (pos >= data.length) return out.result();
      bitBuf = ((bitBuf << 8) | data[pos++]) >>> 0;
      bitCnt += 8;
    }
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    bitBuf &= (1 << bitCnt) - 1;
    if (code === 256) { reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    for (let k = 0; k < entry.length; k++) out.push(entry[k]);
    if (prev) dict.push(prev.concat([entry[0]]));
    prev = entry;
    if (dict.length + (earlyChange ? 1 : 0) >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return out.result();
}
