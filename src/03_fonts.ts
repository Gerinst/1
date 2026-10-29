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
