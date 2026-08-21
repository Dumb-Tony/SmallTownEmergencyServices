/* Who can be on the crew — GDD player fantasy, first line: "One to four players begin
 * each shift at a small volunteer station."
 *
 * This is a DATA module and it imports nothing, which is the whole reason it exists as
 * one. The table started life in src/game.js, and the moment the wire format needed to
 * know what colour a third volunteer wears, `protocol.js` had to import `game.js` — which
 * already imports `protocol.js`. A `const` in a cycle is not a hoisted function: it sits
 * in the temporal dead zone and throws on whichever module happens to be evaluated first.
 * The crew is a fact about the game, not a behaviour of it, so it lives beside the town
 * and the equipment.
 *
 * ⚠ A NULL PREFIX IS NOT AN EMPTY ONE. `readCommand` builds action names as
 * `prefix ? prefix + Name : name`, so a falsy prefix reads r1's bare keys — seating r3
 * locally would give two crew members the same WASD. Two of the four can share a keyboard
 * because there is one keyboard; r3 and r4 exist only over the wire, and null is how that
 * is said in a way the input layer cannot get wrong.
 */

/* ⚠ THESE FOUR WERE SEARCHED FOR, NOT PICKED. Six pairs have to stay apart under normal
 * vision and all three colour-vision simulations, and the two obvious extra colours —
 * a lime and a hot pink — measured 4.8 against a threshold of 11: `#b9f06a` IS the
 * player's own gold to a deuteranope, and `#ef8fd0` is that same gold to a tritanope.
 * Three of six pairs collapsed, including the one carrying "which of these is me", and
 * no single simulation catches both. Worst pair now is partner/vol3 at 16.5.
 *
 * The reason there is no lightness ladder: a crew tint is also TEXT — hud.js paints each
 * name in it at 11px bold, which needs 4.5:1 on the pill plate, which floors L* at 57.
 * So this is two tiers of two, hue apart within a tier and 18–23 L* apart across. The
 * whole search and its rejected candidates are in tools/m10-tests.js section D27. */
export const CREW = Object.freeze([
  { id: 'r1', name: 'You',         tint: '#f6c445', prefix: '' },
  { id: 'r2', name: 'Partner',     tint: '#5fd0f0', prefix: 'p2' },
  { id: 'r3', name: 'Volunteer 3', tint: '#a474fc', prefix: null },
  { id: 'r4', name: 'Volunteer 4', tint: '#bc7ca4', prefix: null },
]);

/** Four hands is the fantasy, and since Tanker 1 there are four bays to match, so a
 *  fifth would be somebody with nothing of their own to drive. */
export const MAX_CREW = CREW.length;

export const CREW_BY_ID = Object.freeze(
  Object.fromEntries(CREW.map((c) => [c.id, c])));
