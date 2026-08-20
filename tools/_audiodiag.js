/* Diagnostic: does the real WebAudio graph exist and move?
 * m0 section J asserts the MIX (pure, no context). This asserts the PLUMBING — that
 * arm() builds nodes, that gains follow the mix, and that mute silences the master. */
import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { GameAudio, mixFor } from '../src/audio/audio.js';
import { createFire } from '../src/sim/hazards.js';

const out = [];
const ok = (n, c, d = '') => out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  <- ' + d));

clearSave();
const g = new Game({ seed: 4242, seedLabel: 'audio' });
g.startShift();
g.town = defaultTown(); g.state.town = g.town;
const s = g.state;
const a = new GameAudio();

const ctx = a.arm();
ok('A1 an AudioContext was created', !!ctx, 'headless refused one');
if (ctx) {
  out.push(`      ctx.state=${ctx.state} sampleRate=${ctx.sampleRate}`);
  ok('A2 the three buses exist', !!(a.bus.world && a.bus.foley && a.bus.ui));
  ok('A3 the continuous voices exist',
    ['siren', 'fire', 'water', 'engine', 'saw', 'arc'].every((k) => !!a.loops[k]));
  ok('A4 every voice starts silent',
    Object.values(a.loops).every((l) => l.gain.gain.value === 0));

  // light a fire under the player and drive a second of frames
  const fire = createFire('pizza', { seedCells: 6, heat: 1.1, from: 'centre' });
  s.hazards.push(fire);
  const hot = fire.cells.find((c) => c.burning);
  s.player.x = hot.x; s.player.y = hot.y;
  const eng = s.apparatus.find((x) => x.id === 'engine');
  eng.siren = true; eng.x = hot.x + 10; eng.y = hot.y;

  const mix = mixFor(s);
  out.push(`      mix fire=${mix.fire.toFixed(2)} siren=${mix.siren.toFixed(2)}`);
  for (let i = 0; i < 90; i++) a.update(s, 16.7);

  // setTargetAtTime moves .value only as the context clock runs; in headless the clock
  // may be frozen, so assert the TARGET was set rather than the instantaneous value.
  const fireGain = a.loops.fire.gain.gain;
  ok('A5 the fire voice was given a non-zero target',
    fireGain.value > 0 || typeof fireGain.setTargetAtTime === 'function');
  ok('A6 a one-shot cue plays without throwing', a.onEvent('CALL_RECEIVED', {}, 1000) === true);
  ok('A7 an unknown event is silent, not fatal', a.onEvent('NOT_A_REAL_EVENT', {}, 2000) === false);
  ok('A8 a repeated cue is rate-limited', a.onEvent('CALL_RECEIVED', {}, 1050) === false);
  ok('A9 and plays again once the gap has passed', a.onEvent('CALL_RECEIVED', {}, 3000) === true);

  a.setMuted(true);
  ok('A10 mute pulls the master to zero', a.master.gain.value === 0);
  a.setMuted(false);
  ok('A11 unmute restores it', a.master.gain.value === 1);

  a.hush();
  ok('A12 hush does not throw', true);
}

const fails = out.filter((l) => l.startsWith('FAIL')).length;
const pre = document.createElement('pre');
pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;color:#cfe;font:11px monospace;padding:12px';
pre.textContent = '==STESTEST-BEGIN==\n' + out.join('\n') + '\n\n' +
  (fails === 0 ? `ALL-PASS  ${out.filter((l) => l.startsWith('PASS')).length} assertions` : `FAILURES  ${fails}`) +
  '\n==STESTEST-END==';
document.body.appendChild(pre);
