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
