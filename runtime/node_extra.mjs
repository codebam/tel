import * as core from './tel_rt.mjs';
import { makeNodeExtra } from './node_factory.mjs';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as proc from 'node:process';
export function makeNodeExtraAdapter() {
  return makeNodeExtra(core, fs, http, path, proc);
}
