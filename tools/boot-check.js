/* Boot check. Not a unit test — it asks the loaded PAGE whether it came up clean, which
 * is the one thing a module-scope suite cannot ask about itself: that the HUD really
 * built, that PeerJS really loaded, and that main.js's frame path survives a live net
 * session being attached to it.
 *
 * It deliberately does NOT start a shift. The harness runs Chrome on a virtual-time
 * budget, and a shift left playing keeps stepping in the background rAF loop until that
 * budget runs out — a three-second check becomes a four-minute one. The simulation is
 * proved by m0–m3; what is proved here is the wiring around it.
 */

import { loopbackPair } from '../src/net/net.js';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';

const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0 ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==STESTEST-END==';
}

try {
  const S = window.__STES;
  const q = (s) => document.querySelector(s);
  const banner = () => document.getElementById('err-banner');
  const bannerText = () => (banner() ? banner().textContent : '');

  lines.push('--- the page comes up ---');
  ok('booted and exposed its handles', !!S && !!S.game && !!S.hud && !!S.net);
  ok('no crash banner', !banner(), bannerText());
  ok('peerjs loaded from the vendored copy', typeof window.Peer === 'function');
  eq('and it starts solo', S.net.role, 'solo');

  lines.push('--- the title card can start a game with someone else ---');
  ok('it offers to play together', !!q('#hostbtn'));
  ok('and to join a room', !!q('#joinbtn') && !!q('#joincode'));
  ok('the status chip exists but is hidden while solo', !!q('#netchip') && q('#netchip').hidden);

  const box = q('#joincode');
  box.value = 'ab-3!x';
  box.dispatchEvent(new Event('input'));
  eq('the code box sanitises what is typed into it', box.value, 'AB3X');

  lines.push('--- what a pasted link looks like ---');
  const meta = (sel) => { const m = document.querySelector(sel); return m ? m.content : null; };
  ok('the page describes itself', (meta('meta[name="description"]') || '').length > 60);
  ok('a pasted link has a title', !!meta('meta[property="og:title"]'));
  ok('and a description', (meta('meta[property="og:description"]') || '').length > 40);
  const img = meta('meta[property="og:image"]') || '';
  ok('and a picture', /^https:\/\/.+\.png$/.test(img), img);
  ok('the picture is an ABSOLUTE url — a relative one previews as nothing',
    img.startsWith('https://'), img);
  eq('sized so it is not cropped to a stripe', meta('meta[property="og:image:width"]'), '1200');
  ok('the picture has alt text', (meta('meta[property="og:image:alt"]') || '').length > 20);
  eq('and it renders large rather than as a thumbnail', meta('meta[name="twitter:card"]'), 'summary_large_image');
  const icon = document.querySelector('link[rel="icon"]');
  ok('there is a real favicon, not a blank one',
    !!icon && icon.href.startsWith('data:image/svg+xml') && icon.href.length > 80);

  lines.push('--- the invitation ---');
  ok('the share row is out of the way until there is a room', q('#sharerow').hidden);
  S.hud.setShareUrl('https://example.test/#room=ABCDE');
  ok('hosting shows a link to send', !q('#sharerow').hidden);
  ok('with the room in it', /#room=ABCDE/.test(q('#shareurl').value));
  ok('and the join row steps aside', q('#netrow').hidden);
  S.hud.setShareUrl(null);
  ok('leaving puts the join row back', !q('#netrow').hidden && q('#sharerow').hidden);
  S.hud.setInvitedCode('PQRST');
  eq('an invitation fills the code box for them', q('#joincode').value, 'PQRST');
  ok('and the button says what it will do', /PQRST/.test(q('#joinbtn').textContent));

  lines.push('--- a real session, attached to the real page ---');
  const [hostLink, partnerLink] = loopbackPair();
  const heard = [];
  partnerLink.onMessage = (m) => heard.push(m);
  S.net.hostOn(hostLink);
  ok('hosting flips the chip on, unprompted', !q('#netchip').hidden);
  partnerLink.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
  eq('a partner joining is reflected in the chip', /connected/.test(q('#netchip').textContent), true);
  eq('and they are on the crew', S.game.state.responders.length, 2);

  /* WATCH the page's own loop rather than calling S.frame() by hand. main.js's frame
     re-schedules itself, so every manual call forks ANOTHER render chain that never
     ends — a dozen of those under a virtual-time budget is a hang, not a test. */
  /* Pump the session by hand rather than calling S.frame() or waiting on rAF. Two
     reasons, both learned the hard way: main.js's frame re-schedules itself, so every
     manual call forks another render chain that never ends; and rAF does not tick
     dependably under --dump-dom, so anything asserted from a callback is never seen.
     pump() is the integration point that matters here anyway — the page's real session,
     encoding the page's real town. */
  S.net.pump(200, null);
  ok('the page\'s own session sends the partner a snapshot',
    heard.some((m) => m.t === MSG.SNAP),
    'heard ' + (heard.map((m) => m.t).join(',') || 'nothing'));
  const snap = heard.find((m) => m.t === MSG.SNAP);
  eq('stamped with the protocol version', snap && snap.v, PROTOCOL_VERSION);
  eq('and carrying both of them', snap && snap.rs.length, 2);
  ok('still no crash banner', !banner(), bannerText());

  /* The overview, driven through the real frame loop.
   *
   * Safe here and nowhere else: under --dump-dom the page's own rAF never ticks, so
   * calling frame() by hand does not fork a render chain the way it does under
   * --screenshot. Thirty frames of a 60 m view widening to the whole town. */
  lines.push('--- hold V for the whole town ---');
  S.startShift();
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) S.frame(t1 + i * 16);
  const tight = S.camera.viewWidthM;
  const timeBefore = S.game.state.simTimeMs;

  S.input.holdVirtual('overview');
  for (let i = 0; i < 45; i++) S.frame(t1 + 400 + i * 16);
  const wide = S.camera.viewWidthM;
  ok('holding it pulls the camera out to the whole town', wide > tight * 2.5,
    `${tight.toFixed(0)} m -> ${wide.toFixed(0)} m`);
  ok('far enough out to see all of it', wide > 380, `${wide.toFixed(0)} m`);
  ok('and the town kept running while the player looked at it',
    S.game.state.simTimeMs > timeBefore, 'rule 3: nothing pauses for a panel');

  S.input.releaseVirtual('overview');
  for (let i = 0; i < 60; i++) S.frame(t1 + 1600 + i * 16);
  ok('letting go comes back to the street', S.camera.viewWidthM < wide * 0.6,
    `${S.camera.viewWidthM.toFixed(0)} m`);
  S.game.togglePause();

  S.net.leave();
  eq('leaving puts the page back to solo', S.net.role, 'solo');
  ok('and hides the chip again', q('#netchip').hidden);
  ok('and the shift the overview check started is paused, not lost',
    S.game.state.mode === 'paused' || S.game.state.mode === 'title', S.game.state.mode);
  emit(null);

  /* Let the page IDLE, now that everything has been asked of it.
   *
   * main.js re-arms requestAnimationFrame on the last line of frame(), so the loop runs
   * until Chrome's virtual-time budget is spent — 600 s of virtual time is 36 000
   * rendered frames, and a headless canvas with no GPU draws them at ten times the cost
   * of a real one. This check finished in three seconds and then sat there painting a
   * title card for seven minutes. Stubbing rAF breaks the chain; it is the same trick
   * the screenshot poses use, and it goes AFTER the assertions so nothing is skipped. */
  window.requestAnimationFrame = () => 0;
} catch (err) {
  fails++;
  lines.push(`FAIL  boot check threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
