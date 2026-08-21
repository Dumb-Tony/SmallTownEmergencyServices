/* Domain event bus — GDD §21.5.
 *
 * Deliberately NOT an event-sourcing framework (GDD says not to build one for the MVP).
 * It is a subscribe/emit pair plus a BOUNDED recent-event log for the debug overlay and
 * the shift report. Bounded matters: GDD §24.1 forbids unbounded trace logs, and a
 * ten-minute shift with 100 bags emits thousands of events.
 *
 * Rendering and UI listen. They never emit gameplay events and never decide rules.
 */

/* The whole vocabulary, in one place, so two systems cannot invent near-duplicate
 * names for the same thing. Simulation modules RETURN event objects; game.js is the
 * only thing that puts them on the bus. */
export const EVENTS = Object.freeze({
  SIM_RESET: 'SIM_RESET', SIM_PAUSED: 'SIM_PAUSED', SIM_RESUMED: 'SIM_RESUMED',
  SHIFT_ENDED: 'SHIFT_ENDED',

  // dispatch and incidents
  CALL_RECEIVED: 'CALL_RECEIVED', CALL_UPDATED: 'CALL_UPDATED',
  PRIORITY_RAISED: 'PRIORITY_RAISED', CREW_ON_SCENE: 'CREW_ON_SCENE',
  INCIDENT_CONTROLLED: 'INCIDENT_CONTROLLED', INCIDENT_LOST: 'INCIDENT_LOST',

  // hazards talking to each other
  FIRE_EXTENDED: 'FIRE_EXTENDED', GAS_FLASH: 'GAS_FLASH',
  WRECK_IGNITED: 'WRECK_IGNITED', UTILITY_ARRIVED: 'UTILITY_ARRIVED',
  STRUCTURE_LOST: 'STRUCTURE_LOST',

  // people
  PATIENT_GRABBED: 'PATIENT_GRABBED', PATIENT_RELEASED: 'PATIENT_RELEASED',
  PATIENT_LOADED: 'PATIENT_LOADED', PATIENT_DELIVERED: 'PATIENT_DELIVERED',
  PATIENT_TREATED: 'PATIENT_TREATED', PATIENT_EXTRICATED: 'PATIENT_EXTRICATED',
  PATIENT_LOST: 'PATIENT_LOST', VICTIM_SHOCKED: 'VICTIM_SHOCKED',
  OCCUPANT_EVACUATING: 'OCCUPANT_EVACUATING', RESPONDER_SHOCKED: 'RESPONDER_SHOCKED',

  // residents — the town's own people, who act whether or not anybody responds
  RESIDENT_OUT: 'RESIDENT_OUT', RESIDENT_TRAPPED: 'RESIDENT_TRAPPED',

  // kit and apparatus
  TOOL_TAKEN: 'TOOL_TAKEN', TOOL_DROPPED: 'TOOL_DROPPED',
  NOTHING_IN_SLOT: 'NOTHING_IN_SLOT', NO_TARGET: 'NO_TARGET',
  ENTERED_APPARATUS: 'ENTERED_APPARATUS', EXITED_APPARATUS: 'EXITED_APPARATUS',
  SIREN_TOGGLED: 'SIREN_TOGGLED', APPARATUS_STRUCK: 'APPARATUS_STRUCK',
  HYDRANT_STRUCK: 'HYDRANT_STRUCK', HYDRANT_CHARGED: 'HYDRANT_CHARGED',
  TANK_DRY: 'TANK_DRY', HOSE_TAUT: 'HOSE_TAUT', EXTINGUISHER_EMPTY: 'EXTINGUISHER_EMPTY',
  ROAD_CLEARED: 'ROAD_CLEARED', LINE_DE_ENERGISED: 'LINE_DE_ENERGISED',
  GAS_SHUT_OFF: 'GAS_SHUT_OFF',
});

export class EventBus {
  constructor({ logSize = 256 } = {}) {
    this._handlers = new Map();   // type -> Set<fn>
    this._any = new Set();
    this.logSize = logSize;
    this.log = [];                // ring, newest last
    this.emitted = 0;
  }

  /** @returns {() => void} unsubscribe */
  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** @returns {() => void} unsubscribe */
  onAny(fn) { this._any.add(fn); return () => this._any.delete(fn); }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload = {}, simTimeMs = 0) {
    const evt = { type, simTimeMs, ...payload };
    this.emitted++;

    this.log.push(evt);
    if (this.log.length > this.logSize) this.log.shift();

    const set = this._handlers.get(type);
    // iterate a copy: a handler may unsubscribe itself mid-dispatch
    if (set) for (const fn of Array.from(set)) fn(evt);
    for (const fn of Array.from(this._any)) fn(evt);
    return evt;
  }

  /** Most recent events, newest first. Debug overlay only. */
  recent(n = 8) { return this.log.slice(-n).reverse(); }

  clearLog() { this.log.length = 0; this.emitted = 0; }

  /** Drop every subscriber. Restart rebuilds systems, so stale closures must not survive. */
  clearHandlers() { this._handlers.clear(); this._any.clear(); }
}
