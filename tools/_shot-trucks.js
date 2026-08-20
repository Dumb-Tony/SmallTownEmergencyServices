/* Poses the three appliances on the apron for a close look at the vehicle art. */
const S = window.__STES;
S.startShift();
const s = S.game.state;
S.game.clock.setPaused(true);
s.apparatus[1].siren = true;
S.camera.follow(s.apparatus[1].x, s.apparatus[1].y - 4, 0);
S.camera.viewWidthM = 46;
S.camera._recomputeScale();
S.camera.follow(s.apparatus[1].x, s.apparatus[1].y - 4, 0);
S.camera.resize(document.getElementById('stage'));
S.renderer.render(s, performance.now());
S.hud.update();
