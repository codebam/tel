import * as core from './tel_rt.mjs';
import { makeWebExtra } from './web_factory.mjs';
export function makeWebExtraAdapter() { return makeWebExtra(core); }
