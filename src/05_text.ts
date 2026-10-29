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
