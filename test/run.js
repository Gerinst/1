// Node harness: runs the compiled Office Script against every fixture.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dist = path.join(__dirname, "..", "dist", "js", "AvisPdfAmount.js");
const src = fs.readFileSync(dist, "utf8");
const main = new Function(src + "\nreturn main;")();

const fixDir = path.join(__dirname, "fixtures");
const expected = JSON.parse(fs.readFileSync(path.join(fixDir, "expected.json"), "utf8"));
const only = process.argv[2];
let pass = 0, fail = 0;
for (const name of Object.keys(expected).sort()) {
  if (only && !name.includes(only)) continue;
  const file = path.join(fixDir, name);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) { console.log("SKIP (missing)", name); continue; }
  const b64 = fs.readFileSync(file).toString("base64");
  const t0 = Date.now();
  const r = main({}, b64, "");
  const ms = Date.now() - t0;
  const want = expected[name];
  let ok;
  if (want === "") ok = r.ok === false; // expected failure (encrypted etc.)
  else ok = r.ok && r.amount === want;
  if (ok) pass++; else fail++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name.padEnd(30) + " amount=" + JSON.stringify(r.amount) + " want=" + JSON.stringify(want) + " method=" + r.method + " pages=" + r.pages + " " + ms + "ms" + (r.error ? " error=" + r.error : "") + (r.warnings ? " warn=" + r.warnings.substring(0, 120) : ""));
  if (!ok || process.env.VERBOSE) {
    console.log("---- text ----\n" + r.text.substring(0, 1500) + "\n---- candidates ----\n" + r.candidates.join("\n"));
    try {
      const ref = execFileSync("pdftotext", ["-layout", file, "-"]).toString("utf8");
      console.log("---- pdftotext ----\n" + ref.substring(0, 800));
    } catch (e) { /* ignore */ }
  }
}
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
