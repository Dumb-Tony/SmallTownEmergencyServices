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

  S.net.leave();
  eq('leaving puts the page back to solo', S.net.role, 'solo');
  ok('and hides the chip again', q('#netchip').hidden);
  eq('the town is still on the title card, unstarted', S.game.state.mode, 'title');
  emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  boot check threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
