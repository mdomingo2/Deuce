/**
 * The Zork I profile.
 *
 * Every number here was recovered from `zork1-r88-s840726.z3` itself rather
 * than copied from a reference, because the ZIL compiler assigns property
 * numbers per build and a table borrowed from a different release would be
 * subtly, silently wrong.
 *
 * How each one was established:
 *
 *   directions   West of House declares property 31 holding the object number
 *                of North of House, 28 holding South of House and 29 holding
 *                Forest, which fixes north/south/west; the rest follow from
 *                Behind House, whose property 29 is a five-byte door exit
 *                naming the Kitchen and the kitchen window, and from the
 *                Kitchen, whose property 23 leads to the Attic and 22 down
 *                the chimney to the Studio.
 *   value (13)   The Kitchen carries 10 and the Cellar 25, which is exactly
 *                what the score does on first entering each.
 *   size (15)    The gold coffin is 55, the sword 30, the lantern 15 and the
 *                leaflet 2 — the familiar ordering of what fills your hands.
 *   providesLight (20)
 *                The brass lantern gains this attribute on "turn on lamp" and
 *                loses it on "turn off lamp". Rooms that are lit without a
 *                lamp carry the same bit, which is how the game asks one
 *                question of both.
 *   open (11)    The mailbox and the kitchen window each gain it when opened.
 *   touched (3)  The leaflet gains it when taken, the Cellar when entered.
 *   lit global (66)
 *                Flips to 0 on turning the lamp off in the Cellar and back to
 *                1 on turning it on, and does not move when the lamp is
 *                toggled somewhere already lit.
 *
 * The tests re-derive the load-bearing ones against the real story file, so
 * pointing this at a different release fails rather than quietly misreading.
 */

import type { StoryProfile } from './world.js';

export const ZORK1_R88: StoryProfile = {
  name: 'Zork I: The Great Underground Empire',
  release: 88,
  serial: '840726',
  /** The ADVENTURER object, whose printed name is "cretin". */
  playerObject: 4,

  directionProperties: {
    north: 31,
    east: 30,
    west: 29,
    south: 28,
    northeast: 27,
    northwest: 26,
    southeast: 25,
    southwest: 24,
    up: 23,
    down: 22,
    in: 21,
    out: 20,
  },

  properties: {
    size: 15,
    value: 13,
    trophyValue: 12,
    capacity: 10,
    scenery: 5,
    longDescription: 11,
  },

  attributes: {
    touched: 3,
    open: 11,
    takeable: 17,
    container: 19,
    providesLight: 20,
    actor: 30,
    transparent: 14,
  },

  globals: {
    location: 0,
    score: 1,
    moves: 2,
    lit: 66,
    /**
     * Zork I's load allowance, 100 units. The game enforces it itself; this is
     * read only so the interface can show how close to it you are.
     */
    carryLimit: 133,
  },
};
