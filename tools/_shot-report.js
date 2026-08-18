/* Poses the end-of-shift report for tools\shot.ps1: a full ten minutes run with
 * nobody responding, which is the worst-case newspaper. */
import { CONFIG } from '../src/config.js';
const S = window.__STES;
const g = S.game;
S.startShift();
g.clock.skipMs(CONFIG.shift.durationMs + 2000, (ms) => g.step(ms, null));
for (let i = 0; i < 3; i++) S.frame(performance.now());
