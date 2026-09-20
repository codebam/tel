#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = typeof code === 'number' ? code : 0;
}).catch((e) => {
  console.error(e?.stack || String(e));
  process.exitCode = 1;
});
