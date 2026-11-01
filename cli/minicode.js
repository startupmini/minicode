#!/usr/bin/env bun
// Gerbang bin untuk npm. Bin berupa berkas `.ts` kurang disukai tooling npm,
// dan path bin dengan prefix `./` memicu warning `"bin[...] ... invalid and removed"`
// saat publish. Wrapper `.js` ini memuat entry CLI TypeScript asli (cli/index.ts)
// via Bun; seluruh logika tetap di index.ts.
import "./index.ts"
