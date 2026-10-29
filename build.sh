#!/bin/bash
# Concatenates the parts into one Office Script file and type-checks it.
set -e
cd "$(dirname "$0")"
mkdir -p dist
{
  cat src/01_core.ts
  echo
  cat src/_tables.ts
  echo
  cat src/02_parser.ts
  echo
  cat src/03_fonts.ts
  echo
  cat src/04_content.ts
  echo
  cat src/05_text.ts
  echo
  cat src/06_main.ts
} > dist/AvisPdfAmount.ts
cat > dist/excelscript-stub.d.ts <<'STUB'
declare namespace ExcelScript { interface Workbook { getName(): string } }
STUB
tsc --noEmit --strict --noImplicitAny --noImplicitReturns --target ES2019 --lib ES2019 --types "" dist/AvisPdfAmount.ts dist/excelscript-stub.d.ts
# JS build for the Node test harness
tsc --strict --target ES2019 --lib ES2019 --types "" --outDir dist/js dist/AvisPdfAmount.ts dist/excelscript-stub.d.ts
echo "build ok: $(wc -l < dist/AvisPdfAmount.ts) lines, $(wc -c < dist/AvisPdfAmount.ts) bytes"
