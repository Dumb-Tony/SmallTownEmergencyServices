/* The invitation.
 *
 * A five-character room code is fine when the other person is in the room with you and
 * awful when they are not: you have to say it, they have to type it, and O/0 and I/1
 * exist. What people actually do with a game is paste a link into a chat.
 *
 * So the host's own address bar becomes the invitation — the same page, with the room
 * on the end of it — and opening one joins that room. Two pure functions, because a URL
 * arriving from outside the program is untrusted input and untrusted input is exactly
 * the kind of thing that should be assertable.
 */

/** The alphabet randCode() draws from: no letters that can be misread or misheard. */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_CHARS}]{4,6}$`);

/**
 * Read a room code out of a URL, from `#room=` or `?room=`.
 *
 * Anything that is not a plausible code returns null rather than being passed along:
 * the code goes straight into a PeerJS peer id, and a URL is the one input a stranger
 * controls completely.
 */
export function roomFromUrl(href) {
  if (typeof href !== 'string' || !href) return null;
  const m = /[#?&]room=([^&#\s]*)/i.exec(href);
  if (!m) return null;
  const code = decodeURIComponent(m[1] || '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/**
 * The link to send somebody, built from the page you are already on.
 * Any existing room on the URL is replaced rather than appended to.
 */
export function shareUrl(href, code) {
  if (typeof href !== 'string' || !href) return '';
  if (!code) return href;
  const clean = String(code).trim().toUpperCase();
  const base = href.split('#')[0].replace(/([?&])room=[^&]*&?/i, '$1').replace(/[?&]$/, '');
  return `${base}#room=${clean}`;
}
