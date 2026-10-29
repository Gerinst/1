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
