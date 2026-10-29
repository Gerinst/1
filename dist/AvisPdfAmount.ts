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
interface PStream { t: "stream"; d: PDict; raw: string; id: number }
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

// character classes
function isWs(c: number): boolean {
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
class Lexer {
  pos = 0;
  constructor(public s: string, pos: number) {
    this.pos = pos;
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
  /** Parses one object. Keywords are returned as PKw. Returns null at EOF. */
  parse(depth: number): PObj | null {
    this.skipWs();
    const s = this.s;
    if (this.pos >= s.length) return null;
    if (depth > 300) throw new Error("nesting too deep");
    const c = s.charCodeAt(this.pos);
    if (c === 47) { // '/' name
      this.pos++;
      let raw = this.readRegular();
      if (raw.indexOf("#") >= 0) {
        raw = raw.replace(/#([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
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
    const flush = (): void => {
      if (pendingKey !== null) {
        d.m.set(pendingKey, vals.length > 0 ? vals[vals.length - 1] : null);
      }
      pendingKey = null;
      vals.length = 0;
    };
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
        flush();
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
    flush();
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
// object streams, trailer, stream decoding, page tree
// ---------------------------------------------------------------------
interface ObjEntry { obj: PObj; pos: number }

class PdfDoc {
  objs = new Map<number, ObjEntry>();
  streamCache = new Map<number, Uint8Array>();
  trailerRoot: PRef | null = null;
  encrypted = false;
  warnings: string[] = [];
  nextStreamId = 1;

  constructor(public s: string) {
    this.scan();
    this.expandObjectStreams();
  }

  private scan(): void {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(s)) !== null) {
      if (++guard > 500000) break;
      const num = parseInt(m[1], 10);
      const start = m.index;
      let after = start + m[0].length;
      try {
        const lx = new Lexer(s, after);
        let obj = lx.parse(0);
        if (obj !== null && isKw(obj)) obj = null;
        lx.skipWs();
        let end = lx.pos;
        if (isDict(obj) && s.substring(lx.pos, lx.pos + 6) === "stream") {
          const r = this.readStream(obj, lx.pos + 6);
          obj = r.stream;
          end = r.end;
        }
        this.objs.set(num, { obj: obj, pos: start });
        after = Math.max(after, end);
      } catch (e) {
        this.warnings.push("object " + num + ": " + String(e));
      }
      re.lastIndex = after;
    }
    // trailer(s): the last one in the file is the newest
    const tre = /trailer\s*<</g;
    let tm: RegExpExecArray | null;
    let lastTrailerPos = -1;
    while ((tm = tre.exec(s)) !== null) {
      try {
        const lx = new Lexer(s, tm.index + 7);
        const d = lx.parse(0);
        if (isDict(d)) {
          if (d.m.has("Encrypt")) this.encrypted = true;
          const root = d.m.get("Root");
          if (root !== undefined && isRef(root)) { this.trailerRoot = root; lastTrailerPos = tm.index; }
        }
      } catch (e) { /* ignore */ }
    }
    // cross-reference streams carry the trailer entries too
    this.objs.forEach((e: ObjEntry) => {
      if (isStream(e.obj)) {
        const ty = e.obj.d.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "XRef") {
          if (e.obj.d.m.has("Encrypt")) this.encrypted = true;
          const root = e.obj.d.m.get("Root");
          if (root !== undefined && isRef(root) && e.pos > lastTrailerPos) { this.trailerRoot = root; lastTrailerPos = e.pos; }
        }
      }
    });
  }

  private readStream(d: PDict, p: number): { stream: PStream; end: number } {
    const s = this.s;
    // after the 'stream' keyword: CRLF or LF
    if (s.charCodeAt(p) === 13) p++;
    if (s.charCodeAt(p) === 10) p++;
    const dataStart = p;
    let len = -1;
    const L = d.m.get("Length");
    if (L !== undefined && isNum(L)) len = L;
    // (an indirect /Length is resolved by searching for "endstream" below)
    let dataEnd = -1;
    if (len >= 0 && dataStart + len <= s.length) {
      const probe = new Lexer(s, dataStart + len);
      probe.skipWs();
      if (s.substring(probe.pos, probe.pos + 9) === "endstream") dataEnd = dataStart + len;
    }
    if (dataEnd < 0) {
      // fall back to searching the keyword
      let idx = s.indexOf("endstream", dataStart);
      if (idx < 0) idx = s.length;
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
    return { stream: { t: "stream", d: d, raw: raw, id: this.nextStreamId++ }, end: end };
  }

  private expandObjectStreams(): void {
    const stms: { entry: ObjEntry; num: number }[] = [];
    this.objs.forEach((e: ObjEntry, num: number) => {
      if (isStream(e.obj)) {
        const ty = e.obj.d.m.get("Type");
        if (ty !== undefined && isName(ty) && ty.v === "ObjStm") stms.push({ entry: e, num: num });
      }
    });
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
          // position rule: the definition that appears later in the file wins
          if (existing === undefined || existing.pos < st.entry.pos) {
            this.objs.set(onum, { obj: obj === null || isKw(obj) ? null : obj, pos: st.entry.pos });
          }
        }
      } catch (e) {
        this.warnings.push("ObjStm " + st.num + ": " + String(e));
      }
    }
  }

  // --- object access ---
  resolve(o: PObj | undefined): PObj {
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

  // --- stream decoding ---
  streamData(st: PStream): Uint8Array {
    const cached = this.streamCache.get(st.id);
    if (cached !== undefined) return cached;
    let data = latin1ToBytes(st.raw);
    const filters: string[] = [];
    const f = this.resolve(st.d.m.get("Filter"));
    if (isName(f)) filters.push(f.v);
    else if (isArr(f)) for (const x of f.v) { const n = this.resolve(x); if (isName(n)) filters.push(n.v); }
    const parmsObj = this.resolve(st.d.m.get("DecodeParms"));
    const parms: (PDict | null)[] = [];
    if (isDict(parmsObj)) parms.push(parmsObj);
    else if (isArr(parmsObj)) for (const x of parmsObj.v) { const d = this.resolve(x); parms.push(isDict(d) ? d : null); }
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i];
      const pd = parms.length === 1 && filters.length === 1 ? parms[0] : (parms[i] || null);
      if (name === "FlateDecode" || name === "Fl") {
        data = inflate(data);
        data = this.predict(data, pd);
      } else if (name === "LZWDecode" || name === "LZW") {
        data = lzwDecode(data, this.num(pd ? pd.m.get("EarlyChange") : undefined, 1));
        data = this.predict(data, pd);
      } else if (name === "ASCIIHexDecode" || name === "AHx") {
        data = asciiHexDecode(data);
      } else if (name === "ASCII85Decode" || name === "A85") {
        data = ascii85Decode(data);
      } else if (name === "RunLengthDecode" || name === "RL") {
        data = runLengthDecode(data);
      } else if (name === "Crypt") {
        // identity crypt filter – nothing to do
      } else {
        // image / unsupported filters: leave as is
        break;
      }
    }
    this.streamCache.set(st.id, data);
    return data;
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

  // --- page tree ---
  pages(): { dict: PDict; resources: PDict | null }[] {
    const out: { dict: PDict; resources: PDict | null }[] = [];
    const seen = new Set<PDict>();
    let root: PDict | null = this.trailerRoot ? this.dictOf(this.trailerRoot) : null;
    if (!root) root = this.findCatalog();
    const pagesRoot = root ? this.dictOf(root.m.get("Pages")) : null;
    const walk = (node: PDict, inherited: PDict | null, depth: number): void => {
      if (depth > 64 || seen.has(node)) return;
      seen.add(node);
      const res = this.dictOf(node.m.get("Resources")) || inherited;
      const type = this.nameOf(node.m.get("Type"));
      const kids = this.arrOf(node.m.get("Kids"));
      if (type === "Page" || (kids.length === 0 && node.m.has("Contents"))) {
        out.push({ dict: node, resources: res });
        return;
      }
      for (const k of kids) {
        const kd = this.dictOf(k);
        if (kd) walk(kd, res, depth + 1);
      }
    };
    if (pagesRoot) walk(pagesRoot, null, 0);
    if (out.length === 0) {
      // fallback: every /Type /Page object in file order
      const found: { d: PDict; pos: number }[] = [];
      this.objs.forEach((e: ObjEntry) => {
        if (isDict(e.obj) && this.nameOf(e.obj.m.get("Type")) === "Page") found.push({ d: e.obj, pos: e.pos });
      });
      found.sort((a, b) => a.pos - b.pos);
      for (const f of found) {
        let res = this.dictOf(f.d.m.get("Resources"));
        let parent = this.dictOf(f.d.m.get("Parent"));
        for (let i = 0; !res && parent && i < 32; i++) {
          res = this.dictOf(parent.m.get("Resources"));
          parent = this.dictOf(parent.m.get("Parent"));
        }
        out.push({ dict: f.d, resources: res });
      }
    }
    return out;
  }

  private findCatalog(): PDict | null {
    let found: PDict | null = null;
    this.objs.forEach((e: ObjEntry) => {
      if (found === null && isDict(e.obj) && this.nameOf(e.obj.m.get("Type")) === "Catalog") found = e.obj;
    });
    return found;
  }

  pageContent(page: PDict): string {
    const c = this.resolve(page.m.get("Contents"));
    if (isStream(c)) return this.streamText(c);
    if (isArr(c)) {
      let s = "";
      for (const x of c.v) {
        const st = this.resolve(x);
        if (isStream(st)) s += this.streamText(st) + "\n";
      }
      return s;
    }
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

/** mode "uni": destinations are UTF-16BE strings; mode "cid": destinations are integers */
function parseCMap(text: string, mode: "uni" | "cid"): CMapData {
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

// ---------------------------------------------------------------------
// Glyph names -> Unicode
// ---------------------------------------------------------------------
function glyphNameToUnicode(name: string): string {
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
interface TtMaps { gidToUni: Map<number, string>; codeToGid: Map<number, number>; hasUni: boolean }

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
  if (cmapOff < 0 || cmapOff + 4 > data.length) return null;
  void cmapLen;
  const maps: TtMaps = { gidToUni: new Map<number, string>(), codeToGid: new Map<number, number>(), hasUni: false };
  const n = u16(cmapOff + 2);
  const addUni = (cp: number, gid: number): void => {
    if (gid === 0) return;
    if (!maps.gidToUni.has(gid)) {
      if (cp <= 0xffff) maps.gidToUni.set(gid, String.fromCharCode(cp));
      else { const v = cp - 0x10000; maps.gidToUni.set(gid, String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))); }
    }
  };
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
    const put = (code: number, gid: number): void => {
      if (isUni) { addUni(code, gid); maps.hasUni = true; }
      else if (isSym) { if (!maps.codeToGid.has(code & 0xff)) maps.codeToGid.set(code & 0xff, gid); }
      else if (isMac) { if (!maps.codeToGid.has(code)) maps.codeToGid.set(code, gid); }
    };
    if (format === 0) {
      for (let c = 0; c < 256; c++) put(c, data[sub + 6 + c]);
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
          put(c, gid);
        }
      }
    } else if (format === 6) {
      const first = u16(sub + 6), cnt = u16(sub + 8);
      for (let k = 0; k < cnt; k++) put(first + k, u16(sub + 10 + k * 2));
    } else if (format === 12) {
      const nGroups = u32(sub + 12);
      for (let g = 0; g < nGroups && g < 100000; g++) {
        const gp = sub + 16 + g * 12;
        if (gp + 12 > data.length) break;
        const sc = u32(gp), ec = u32(gp + 4), sg = u32(gp + 8);
        for (let c = sc; c <= ec && c - sc < 65536; c++) put(c, sg + (c - sc));
      }
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
}

interface Glyph { code: number; u: string; w: number; isSpace: boolean }

class FontLoader {
  cache = new Map<PDict, FontInfo>();
  fallbackFont: FontInfo | null = null;
  constructor(public doc: PdfDoc) {}

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

  /** Helvetica/WinAnsi stand-in for missing font resources */
  fallback(): FontInfo {
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
        const fm = doc.arrOf(d.m.get("FontMatrix"));
        if (fm.length === 6) f.fontMatrix = fm.map((v: PObj) => doc.num(v, 0));
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

  /** Splits a PDF string into glyphs (code, unicode, width/1000). */
  decode(f: FontInfo, s: string): Glyph[] {
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
            if (gid !== undefined) { const g = f.tt.gidToUni.get(gid); if (g !== undefined) u = g; }
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
        if (g !== undefined) u = g;
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

interface GState { ctm: Mat; font: FontInfo | null; size: number; charSp: number; wordSp: number; hscale: number; leading: number; rise: number }

class ContentInterpreter {
  items: TextItem[] = [];
  fonts: FontLoader;
  formDepth = 0;
  ops = 0;
  deadline = Date.now() + 90000; // stay well below the 120 s Power Automate limit

  constructor(public doc: PdfDoc) {
    this.fonts = new FontLoader(doc);
  }

  runPage(content: string, resources: PDict | null, page: number): void {
    const gs: GState = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0 };
    this.run(content, resources, gs, page, new Set<number>());
  }

  /** Text inside form-field / annotation appearance streams (filled AcroForms, stamps) */
  runAnnotations(pageDict: PDict, resources: PDict | null, page: number): void {
    const doc = this.doc;
    const annots = doc.arrOf(pageDict.m.get("Annots"));
    for (const a of annots) {
      const ad = doc.dictOf(a);
      if (!ad) continue;
      const sub = doc.nameOf(ad.m.get("Subtype"));
      if (sub === "Link" || sub === "Popup") continue;
      const flags = doc.num(ad.m.get("F"), 0);
      if (flags & 2) continue; // hidden
      const ap = doc.dictOf(ad.m.get("AP"));
      if (!ap) continue;
      let n = doc.resolve(ap.m.get("N"));
      if (isDict(n)) { // appearance sub-dictionary keyed by state
        const as = doc.nameOf(ad.m.get("AS"));
        const pick = as !== "" ? n.m.get(as) : (n.m.size > 0 ? n.m.values().next().value : undefined);
        n = doc.resolve(pick);
      }
      if (!isStream(n)) continue;
      const rect = doc.arrOf(ad.m.get("Rect")).map((v: PObj) => doc.num(v, 0));
      const bbox = doc.arrOf(n.d.m.get("BBox")).map((v: PObj) => doc.num(v, 0));
      let ctm: Mat = [1, 0, 0, 1, 0, 0];
      const mtx = doc.arrOf(n.d.m.get("Matrix")).map((v: PObj) => doc.num(v, 0));
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
      const gs: GState = { ctm: ctm, font: null, size: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0 };
      const res = doc.dictOf(n.d.m.get("Resources")) || resources;
      try { this.run(doc.streamText(n), res, gs, page, new Set<number>([n.id])); } catch (e) { doc.warnings.push("annotation: " + String(e)); }
    }
  }

  private run(content: string, resources: PDict | null, gsIn: GState, page: number, visited: Set<number>): void {
    const doc = this.doc;
    const lx = new Lexer(content, 0);
    const stack: PObj[] = [];
    const gsStack: GState[] = [];
    let gs: GState = gsIn;
    let tm: Mat = [1, 0, 0, 1, 0, 0];
    let tlm: Mat = [1, 0, 0, 1, 0, 0];
    const fontDict = resources ? doc.dictOf(resources.m.get("Font")) : null;
    const xobjDict = resources ? doc.dictOf(resources.m.get("XObject")) : null;

    const showText = (str: string): void => {
      const f = gs.font;
      if (!f) {
        // no font selected: still advance roughly so following text is placed sensibly
        tm = matMul([1, 0, 0, 1, str.length * 0.5 * gs.size * gs.hscale, 0], tm);
        return;
      }
      const glyphs = this.fonts.decode(f, str);
      const trm: Mat = matMul(matMul([gs.size * gs.hscale, 0, 0, gs.size, 0, gs.rise], tm), gs.ctm);
      const scale = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]) / Math.max(gs.size * gs.hscale, 1e-9);
      let text = "";
      let advance = 0; // text space units (before hscale)
      for (const g of glyphs) {
        const w0 = f.type3 ? g.w / 1000 : g.w / 1000;
        let tx = w0 * gs.size + gs.charSp;
        if (g.isSpace) tx += gs.wordSp;
        advance += tx;
        text += g.u;
      }
      const devW = advance * gs.hscale * scale;
      const devH = Math.abs(gs.size * Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]) / Math.max(gs.size, 1e-9));
      if (text.length > 0) {
        let rot = Math.round(Math.atan2(trm[1], trm[0]) / (Math.PI / 2)) % 4;
        if (rot < 0) rot += 4;
        this.items.push({ x: trm[4], y: trm[5], w: devW, h: devH > 0 ? devH : Math.abs(gs.size * scale), s: text, sp: (f.spaceWidth / 1000) * gs.size * gs.hscale * scale, page: page, flip: trm[3] < 0, rot: rot });
      }
      tm = matMul([1, 0, 0, 1, advance * gs.hscale, 0], tm);
    };

    let guard = 0;
    for (;;) {
      if (++guard > 5000000) break;
      if ((guard & 4095) === 0 && Date.now() > this.deadline) { doc.warnings.push("time budget exhausted, text truncated"); break; }
      let o: PObj | null;
      try { o = lx.parse(0); } catch (e) { break; }
      if (o === null) { if (lx.pos >= content.length) break; stack.push(null); continue; }
      if (!isKw(o)) { stack.push(o); if (stack.length > 64) stack.shift(); continue; }
      const op = o.v;
      this.ops++;
      const n = (i: number): number => { const v = stack[stack.length - i]; return isNum(v) ? v : 0; };
      switch (op) {
        case "q": gsStack.push({ ctm: gs.ctm, font: gs.font, size: gs.size, charSp: gs.charSp, wordSp: gs.wordSp, hscale: gs.hscale, leading: gs.leading, rise: gs.rise }); if (gsStack.length > 256) gsStack.shift(); break;
        case "Q": { const p = gsStack.pop(); if (p) gs = p; break; }
        case "cm": if (stack.length >= 6) gs.ctm = matMul([n(6), n(5), n(4), n(3), n(2), n(1)], gs.ctm); break;
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
        case "Tj": { const s = stack[stack.length - 1]; if (isStr(s)) showText(s.v); break; }
        case "'": { tlm = matMul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; const s = stack[stack.length - 1]; if (isStr(s)) showText(s.v); break; }
        case "\"": { gs.wordSp = n(3); gs.charSp = n(2); tlm = matMul([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; const s = stack[stack.length - 1]; if (isStr(s)) showText(s.v); break; }
        case "TJ": {
          const a = stack[stack.length - 1];
          if (isArr(a)) {
            for (const el of a.v) {
              if (isStr(el)) showText(el.v);
              else if (isNum(el)) tm = matMul([1, 0, 0, 1, (-el / 1000) * gs.size * gs.hscale, 0], tm);
            }
          }
          break;
        }
        case "Do": {
          const nm = stack[stack.length - 1];
          if (isName(nm) && xobjDict && this.formDepth < 12) {
            const ref = xobjDict.m.get(nm.v);
            const xo = doc.resolve(ref);
            if (isStream(xo) && doc.nameOf(xo.d.m.get("Subtype")) === "Form" && !visited.has(xo.id)) {
              visited.add(xo.id);
              this.formDepth++;
              const saved = gs;
              const sub: GState = { ctm: gs.ctm, font: gs.font, size: gs.size, charSp: gs.charSp, wordSp: gs.wordSp, hscale: gs.hscale, leading: gs.leading, rise: gs.rise };
              const mtx = doc.arrOf(xo.d.m.get("Matrix"));
              if (mtx.length === 6) sub.ctm = matMul([doc.num(mtx[0], 1), doc.num(mtx[1], 0), doc.num(mtx[2], 0), doc.num(mtx[3], 1), doc.num(mtx[4], 0), doc.num(mtx[5], 0)], sub.ctm);
              const res = doc.dictOf(xo.d.m.get("Resources")) || resources;
              try { this.run(doc.streamText(xo), res, sub, page, visited); } catch (e) { doc.warnings.push("XObject " + nm.v + ": " + String(e)); }
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
  }
}

// ---------------------------------------------------------------------
// Line assembly
// ---------------------------------------------------------------------
function assembleLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  let page = -1;
  // group per page, sort by y desc then x asc
  const byPage = new Map<number, TextItem[]>();
  for (const it of items) {
    let arr = byPage.get(it.page);
    if (!arr) { arr = []; byPage.set(it.page, arr); }
    arr.push(it);
  }
  const pageNums: number[] = [];
  byPage.forEach((_v: TextItem[], k: number) => pageNums.push(k));
  pageNums.sort((a, b) => a - b);
  for (const pn of pageNums) {
    const arr = byPage.get(pn) as TextItem[];
    if (page >= 0) lines.push("");
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
      for (const it of g) {
        h = Math.max(it.h, 1);
        const t = it.s;
        if (t.length === 0) continue;
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
      line = line.replace(/\s+$/, "");
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------
// Amount extraction
// ---------------------------------------------------------------------
interface Candidate { amount: string; value: number; score: number; line: string; lineIdx: number; method: string }

const STRONG_KEYWORDS = /gesamt|zahlbetrag|zahlungsbetrag|überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlungsbetrag|gutschriftsbetrag|endbetrag|endsumme|summe|total|nettobetrag der zahlung|betrag der überweisung|wir überweisen|überwiesen|zahlung in höhe|zahlen wir|angewiesen|remittance total|amount paid|payment amount|net amount paid/i;
// words that mean "what was actually paid" – beat generic totals like "Summe Rechnungsbetrag"
const PAYMENT_KEYWORDS = /zahlbetrag|zahlungsbetrag|überweisungsbetrag|ueberweisungsbetrag|überweisungssumme|auszahlung|gutschriftsbetrag|wir überweisen|überwiesen|zahlung in höhe|zahlen wir|angewiesen|amount paid|payment amount|net amount paid|remittance total/i;
const WEAK_KEYWORDS = /betrag|zahlung|überweisung|ueberweisung|amount|payment|eur|€/i;
const NEGATIVE_KEYWORDS = /skonto|abzug|rabatt|steuer|mwst|ust\b|vat|rechnungsbetrag|rechnungssumme|bruttobetrag|brutto|netto\b|offener|offene|restbetrag|fällig|iban|bic|datum|belegnr|beleg-?nr|rechnungsnr|rechnungs-?nummer|kundennr|kunden-?nummer|lieferantennr|seite|page|telefon|tel\.|fax|steuernummer|ust-id|konto\b|blz|zwischensumme|zinsen|mahn/i;

function normalizeLine(line: string): string {
  let s = line.replace(/ /g, " ");
  // glue thousands separators / decimals that got split by positioning: "3 . 454 , 00" -> "3.454,00"
  s = s.replace(/(\d)\s*\.\s*(\d{3})(?=[^\d]|$)/g, "$1.$2");
  s = s.replace(/(\d)\s*,\s*(\d{2})(?=[^\d]|$)/g, "$1,$2");
  s = s.replace(/(^|[^\d.,])(\d{1,3}) (\d{3})(?=,\d{2}(?!\d))/g, "$1$2.$3"); // thin-space thousands: "3 454,00"
  return s;
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

function findAmountsInLine(line: string, english: boolean): { text: string; value: number; index: number }[] {
  const out: { text: string; value: number; index: number }[] = [];
  const re = english
    ? /-?\d{1,3}(?:,\d{3})+\.\d{2}-?|-?\d+\.\d{2}-?/g
    : /-?\d{1,3}(?:\.\d{3})+,\d{2}-?|-?\d+,\d{2}-?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index, end = start + m[0].length;
    const before = start > 0 ? line.charAt(start - 1) : " ";
    const after = end < line.length ? line.charAt(end) : " ";
    if (/[\d.,]/.test(before) || /[\d]/.test(after)) continue;
    // skip things that are obviously dates/ids: "01.10.2026" never matches (needs ,dd) – but "10,00" inside "IBAN"? fine
    const value = english ? parseEnglishAmount(m[0]) : parseGermanAmount(m[0]);
    if (isNaN(value)) continue;
    out.push({ text: m[0].replace(/\s/g, ""), value: value, index: start });
  }
  return out;
}

function detectCurrency(text: string): string {
  if (/€|\bEUR\b/.test(text)) return "EUR";
  if (/\bCHF\b/.test(text)) return "CHF";
  if (/\bUSD\b|\$/.test(text)) return "USD";
  if (/\bGBP\b|£/.test(text)) return "GBP";
  return "EUR";
}

function pickAmount(lines: string[], extraKeywords: string): { best: Candidate | null; candidates: Candidate[]; currency: string } {
  const text = lines.join("\n");
  const currency = detectCurrency(text);
  const normLines = lines.map(normalizeLine);
  const englishFormat = (currency === "USD" || currency === "GBP") && !/\d\.\d{3},\d{2}/.test(text) && /\d,\d{3}\.\d{2}|\d\.\d{2}\b/.test(text);
  let extra: RegExp | null = null;
  const ek = extraKeywords.split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (ek.length > 0) extra = new RegExp(ek.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

  const all: Candidate[] = [];
  const perLine: { idx: number; amounts: { text: string; value: number; index: number }[]; strong: boolean; weak: boolean; neg: boolean }[] = [];
  for (let i = 0; i < normLines.length; i++) {
    const ln = normLines[i];
    const amounts = findAmountsInLine(ln, englishFormat);
    const strong = STRONG_KEYWORDS.test(ln) || (extra !== null && extra.test(ln));
    const weak = WEAK_KEYWORDS.test(ln);
    const neg = NEGATIVE_KEYWORDS.test(ln);
    perLine.push({ idx: i, amounts: amounts, strong: strong, weak: weak, neg: neg });
  }
  for (let i = 0; i < perLine.length; i++) {
    const pl = perLine[i];
    const ln = normLines[i];
    if (pl.amounts.length === 0) {
      // label line without amount: amount may be on the next line(s)
      if (pl.strong) {
        for (let k = 1; k <= 2 && i + k < perLine.length; k++) {
          const nx = perLine[i + k];
          if (nx.amounts.length > 0) {
            const a = nx.amounts[nx.amounts.length - 1];
            let score = 4 - k;
            if (nx.neg) score -= 2;
            if (pl.neg) score -= 2.5;            // label line looks like a table header (Rechnungsbetrag/Skonto …)
            if (ln.length > 45) score -= 1;       // long line = probably a header row, not a label
            if (nx.amounts.length >= 3) score -= 1.5; // next line is a table row
            if (/:\s*$/.test(ln)) score += 0.5;    // "Überweisungsbetrag:"
            all.push({ amount: a.text, value: a.value, score: score, line: ln + " | " + normLines[i + k], lineIdx: i + k, method: "keyword-next-line" });
            break;
          }
          if (nx.strong || nx.neg) break;
        }
      }
      continue;
    }
    for (let j = 0; j < pl.amounts.length; j++) {
      const a = pl.amounts[j];
      let score = 0;
      let method = "largest";
      if (pl.strong) { score += 5; method = "keyword"; }
      else if (pl.weak) { score += 1.5; method = "keyword-weak"; }
      if (PAYMENT_KEYWORDS.test(ln)) score += 1.5;   // "Zahlbetrag" beats "Summe Rechnungsbetrag"
      if (pl.neg && !pl.strong) score -= 2;
      if (pl.neg && pl.strong && !PAYMENT_KEYWORDS.test(ln)) score -= 2;
      if (j === pl.amounts.length - 1) score += 0.5; // right-most amount on the line
      // currency symbol right next to the amount
      const around = ln.substring(Math.max(0, a.index - 6), Math.min(ln.length, a.index + a.text.length + 6));
      if (/€|EUR|CHF|USD|GBP/.test(around)) score += 0.75;
      if (a.value === 0) score -= 3;
      // position: totals are usually in the lower part of the document
      score += (i / Math.max(1, normLines.length)) * 0.5;
      all.push({ amount: a.text, value: a.value, score: score, line: ln, lineIdx: i, method: method });
    }
  }
  // "column sum" signal: the total equals the sum of the last amounts of the preceding rows (Zahlbetrag column)
  let running = 0, contributing = 0;
  for (let i = 0; i < perLine.length; i++) {
    const pl = perLine[i];
    if (pl.amounts.length === 0) continue;
    const last = pl.amounts[pl.amounts.length - 1];
    if (contributing >= 2 && Math.abs(running - last.value) < 0.015 && last.value !== 0) {
      for (const c of all) {
        if (c.lineIdx === i && c.amount === last.text && c.method !== "keyword-next-line") {
          c.score += 2.5;
          if (c.method === "largest" || c.method === "keyword-weak") c.method = "column-sum";
        }
      }
      running = 0; contributing = 0; // a total line resets the column
      continue;
    }
    running += last.value;
    contributing++;
  }
  // "sum of the others" signal: if one amount equals the sum of the remaining amounts on keyword-free lines
  const plain = all.filter((c) => c.method === "largest");
  if (plain.length >= 3) {
    const total = plain.reduce((s, c) => s + c.value, 0);
    for (const c of all) {
      const others = plain.indexOf(c) >= 0 ? total - c.value : total;
      if (Math.abs(others - c.value) < 0.015 && c.value !== 0) { c.score += 2; if (c.method === "largest") c.method = "sum-check"; }
    }
  }
  // magnitude: bigger amounts get a small bonus (totals are larger than line items)
  let maxAbs = 0;
  for (const c of all) maxAbs = Math.max(maxAbs, Math.abs(c.value));
  for (const c of all) if (maxAbs > 0) c.score += (Math.abs(c.value) / maxAbs) * 1.0;
  all.sort((a, b) => (b.score - a.score) || (b.lineIdx - a.lineIdx));
  return { best: all.length > 0 ? all[0] : null, candidates: all.slice(0, 8), currency: currency };
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------
const MAX_TEXT_CHARS = 100000;

function extractPdf(bytes: Uint8Array): { lines: string[]; pages: number; warnings: string[]; encrypted: boolean } {
  const s = bytesToLatin1(bytes, 0, bytes.length);
  const doc = new PdfDoc(s);
  if (doc.encrypted) return { lines: [], pages: 0, warnings: doc.warnings, encrypted: true };
  const pages = doc.pages();
  const interp = new ContentInterpreter(doc);
  for (let i = 0; i < pages.length; i++) {
    try {
      const content = doc.pageContent(pages[i].dict);
      interp.runPage(content, pages[i].resources, i);
      interp.runAnnotations(pages[i].dict, pages[i].resources, i);
    } catch (e) {
      doc.warnings.push("page " + (i + 1) + ": " + String(e));
    }
  }
  const lines = assembleLines(interp.items);
  return { lines: lines, pages: pages.length, warnings: doc.warnings, encrypted: false };
}

function emptyResult(): AvisResult {
  return { ok: false, amount: "", amountNumber: 0, currency: "", line: "", method: "none", confidence: "low", candidates: [], pages: 0, text: "", textLength: 0, warnings: "", error: "" };
}

/**
 * Office Script entry point.
 * @param pdfBase64  Base64 content of the PDF (e.g. contentBytes of "Get attachment (V2)")
 * @param extraKeywords  optional, comma separated extra keywords that mark the total line ("Auszahlung, Überweisungssumme"); may be ""
 */
function main(workbook: ExcelScript.Workbook, pdfBase64: string, extraKeywords?: string): AvisResult {
  const res = emptyResult();
  totalDecoded = 0;
  try {
    if (!pdfBase64 || pdfBase64.length < 16) { res.error = "no PDF content passed"; return res; }
    const bytes = base64ToBytes(pdfBase64);
    if (bytes.length < 8 || bytesToLatin1(bytes, 0, 4) !== "%PDF") {
      // some mail systems prefix junk before %PDF – look for the header anyway
      const probe = bytesToLatin1(bytes, 0, Math.min(bytes.length, 2048));
      if (probe.indexOf("%PDF") < 0) { res.error = "not a PDF (header missing, " + bytes.length + " bytes)"; return res; }
    }
    const ex = extractPdf(bytes);
    res.pages = ex.pages;
    res.warnings = ex.warnings.slice(0, 20).join(" | ");
    if (ex.encrypted) { res.error = "PDF is encrypted – not supported"; return res; }
    const text = ex.lines.join("\n");
    res.textLength = text.length;
    res.text = text.length > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    if (text.replace(/\s/g, "").length === 0) { res.error = ex.pages === 0 ? "no pages found" : "no text layer found (scanned PDF?)"; return res; }
    const pick = pickAmount(ex.lines, extraKeywords || "");
    res.currency = pick.currency;
    res.candidates = pick.candidates.map((c) => c.amount + " | " + c.score.toFixed(2) + " | " + c.method + " | " + c.line.substring(0, 120));
    if (pick.best) {
      res.ok = true;
      res.amount = pick.best.amount;
      res.amountNumber = Math.round(pick.best.value * 100) / 100;
      res.line = pick.best.line;
      res.method = pick.best.method;
      // confidence: rule quality + distance to the next different amount
      let margin = 99;
      for (const c of pick.candidates) if (c.value !== pick.best.value) { margin = pick.best.score - c.score; break; }
      const strongRule = res.method === "keyword" || res.method === "keyword-next-line" || res.method === "column-sum";
      res.confidence = strongRule && margin >= 1.5 ? "high" : (margin >= 0.75 && res.method !== "largest") ? "medium" : "low";
    } else {
      res.error = "no amount pattern found";
    }
    return res;
  } catch (e) {
    res.error = "exception: " + String(e);
    return res;
  }
}
