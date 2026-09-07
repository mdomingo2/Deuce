/**
 * Art direction for the Great Underground Empire.
 *
 * The story file describes every room in prose and nothing else — it has no
 * idea how tall the Dome Room is or that the Temple should feel like marble.
 * This is where that judgement lives, and it is the only part of the project
 * that is invention rather than transcription. It is kept strictly to
 * *appearance*: dimensions, surfaces, colour, light, set dressing. No exit, no
 * object and no rule is decided here.
 *
 * Style resolution runs in three passes, most specific first:
 *
 *   1. an override for a particular object number, for rooms that share a name
 *      (there are four rooms called Forest and eleven called Maze)
 *   2. an override by room name
 *   3. a family chosen by reading the name, falling back to whether the room
 *      lights itself
 *
 * The third pass is what makes the whole map presentable without authoring a
 * hundred and eleven entries by hand: "Twisting Passage" and "Cold Passage"
 * are both passages, and neither needs its own line.
 */

import type { SurfaceKind } from '../scene/materials.js';

export type PropKind =
  | 'trees'
  | 'house-facade'
  | 'columns'
  | 'stalactites'
  | 'rubble'
  | 'water'
  | 'mine-track'
  | 'gravestones'
  | 'mirror'
  | 'rainbow'
  | 'timber'
  | 'coal-seam'
  | 'sand-drift'
  | 'boulder';

export interface RoomStyle {
  /** Extent in metres. The camera stands 1.7m above the floor. */
  width: number;
  depth: number;
  height: number;

  floor: SurfaceKind;
  walls: SurfaceKind;
  /** `null` opens the room to the sky. */
  ceiling: SurfaceKind | null;

  floorTint: string;
  wallTint: string;
  ceilingTint: string;

  /** Ambient fill. Dark rooms get almost none; the lantern does the work. */
  ambient: number;
  ambientColor: string;

  /** Exponential fog, which is what sells depth in a cave. */
  fogDensity: number;
  fogColor: string;

  /** Set dressing, drawn from a small library of procedural props. */
  props: PropKind[];

  /** Seeds the surface noise so a room looks the same on every visit. */
  seed: number;
}

/**
 * The families every room falls into.
 *
 * These are chosen for how a place should *look*, which is not the same as how
 * the game categorises it: the Dam and the Dam Lobby are one family visually
 * even though the game treats the lobby as an ordinary indoor room.
 */
export type RoomFamily =
  | 'forest'
  | 'house-exterior'
  | 'house-interior'
  | 'cellar'
  | 'cave'
  | 'passage'
  | 'maze'
  | 'temple'
  | 'mine'
  | 'water'
  | 'riverbank'
  | 'canyon'
  | 'dam'
  | 'hades'
  | 'vault'
  | 'barrow';

const FAMILIES: Record<RoomFamily, RoomStyle> = {
  /** Overcast New England woodland: cold, grey-green, roofed by leaves. */
  forest: {
    width: 16,
    depth: 16,
    height: 9,
    floor: 'grass',
    walls: 'earth',
    ceiling: null,
    floorTint: '#9fae84',
    wallTint: '#5f6b4e',
    ceilingTint: '#ffffff',
    ambient: 0.55,
    ambientColor: '#b9c4d2',
    fogDensity: 0.028,
    fogColor: '#8c98a4',
    props: ['trees'],
    seed: 11,
  },

  'house-exterior': {
    width: 18,
    depth: 14,
    height: 10,
    floor: 'grass',
    walls: 'earth',
    ceiling: null,
    floorTint: '#a3b088',
    wallTint: '#6a7355',
    ceilingTint: '#ffffff',
    ambient: 0.62,
    ambientColor: '#c2cbd6',
    fogDensity: 0.02,
    fogColor: '#97a2ae',
    props: ['house-facade', 'trees'],
    seed: 23,
  },

  /** Lit from inside, warmer, and small enough to feel like a house. */
  'house-interior': {
    width: 8,
    depth: 7,
    height: 3.2,
    floor: 'plank',
    walls: 'plank',
    ceiling: 'wood',
    floorTint: '#9a7f60',
    wallTint: '#8a705a',
    ceilingTint: '#6b5744',
    ambient: 0.45,
    ambientColor: '#d8c39a',
    fogDensity: 0.012,
    fogColor: '#2a2318',
    props: [],
    seed: 31,
  },

  /** The first taste of underground: damp, close, unlit. */
  cellar: {
    width: 9,
    depth: 8,
    height: 4,
    floor: 'earth',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#6a5a48',
    wallTint: '#6e6a62',
    ceilingTint: '#4c4a45',
    ambient: 0.05,
    ambientColor: '#3d4a5a',
    fogDensity: 0.042,
    fogColor: '#0a0c10',
    props: ['rubble'],
    seed: 47,
  },

  cave: {
    width: 11,
    depth: 10,
    height: 5,
    floor: 'rough-stone',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#6b6558',
    wallTint: '#78716a',
    ceilingTint: '#514c46',
    ambient: 0.045,
    ambientColor: '#3a4655',
    fogDensity: 0.045,
    fogColor: '#08090c',
    props: ['stalactites', 'rubble'],
    seed: 53,
  },

  /** Long and low, so the lantern light runs away down the corridor. */
  passage: {
    width: 4.5,
    depth: 15,
    height: 3.4,
    floor: 'rough-stone',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#645e54',
    wallTint: '#6f6961',
    ceilingTint: '#484440',
    ambient: 0.04,
    ambientColor: '#38404d',
    fogDensity: 0.055,
    fogColor: '#07080b',
    props: ['rubble'],
    seed: 59,
  },

  /**
   * Deliberately featureless. The maze's whole design is that one room is
   * indistinguishable from the next, so giving each a distinct look would
   * quietly solve the puzzle for the player.
   */
  maze: {
    width: 6,
    depth: 6,
    height: 3,
    floor: 'rough-stone',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#5e5a52',
    wallTint: '#67635c',
    ceilingTint: '#454239',
    ambient: 0.035,
    ambientColor: '#333c47',
    fogDensity: 0.06,
    fogColor: '#06070a',
    props: [],
    seed: 61,
  },

  /** Where the empire spent money: cut stone, columns, real height. */
  temple: {
    width: 14,
    depth: 18,
    height: 9,
    floor: 'marble',
    walls: 'stone',
    ceiling: 'stone',
    floorTint: '#9d998e',
    wallTint: '#8b8880',
    ceilingTint: '#5f5c55',
    ambient: 0.16,
    ambientColor: '#c8b389',
    fogDensity: 0.035,
    fogColor: '#14100a',
    props: ['columns'],
    seed: 71,
  },

  mine: {
    width: 8,
    depth: 9,
    height: 3.2,
    floor: 'earth',
    walls: 'earth',
    ceiling: 'wood',
    floorTint: '#4e4238',
    wallTint: '#443a32',
    ceilingTint: '#4a3c2c',
    ambient: 0.03,
    ambientColor: '#3a3630',
    fogDensity: 0.055,
    fogColor: '#060505',
    props: ['timber', 'coal-seam', 'rubble'],
    seed: 79,
  },

  water: {
    width: 16,
    depth: 14,
    height: 7,
    floor: 'sand',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#8a7a5c',
    wallTint: '#6a6660',
    ceilingTint: '#4a4844',
    ambient: 0.1,
    ambientColor: '#5f7d8c',
    fogDensity: 0.05,
    fogColor: '#101a20',
    props: ['water', 'sand-drift'],
    seed: 83,
  },

  /**
   * The river and the lake shore where they run under open sky.
   *
   * Split from `water` because Zork I uses the same room names above and below
   * ground — there are five rooms called Frigid River and only some of them
   * are lit — so the family has to be chosen from the light, not the name.
   */
  riverbank: {
    width: 20,
    depth: 16,
    height: 10,
    floor: 'sand',
    walls: 'rough-stone',
    ceiling: null,
    floorTint: '#a3906c',
    wallTint: '#7d7468',
    ceilingTint: '#ffffff',
    ambient: 0.5,
    ambientColor: '#bcc6d0',
    fogDensity: 0.024,
    fogColor: '#94a0aa',
    props: ['water', 'sand-drift'],
    seed: 109,
  },

  canyon: {
    width: 14,
    depth: 12,
    height: 16,
    floor: 'rough-stone',
    walls: 'rough-stone',
    ceiling: null,
    floorTint: '#8a7862',
    wallTint: '#7d6a55',
    ceilingTint: '#ffffff',
    ambient: 0.5,
    ambientColor: '#c0c8d0',
    fogDensity: 0.022,
    fogColor: '#9aa4b0',
    props: ['boulder'],
    seed: 89,
  },

  /** Engineered concrete and steel, the one modern-feeling place in the game. */
  dam: {
    width: 16,
    depth: 12,
    height: 8,
    floor: 'stone',
    walls: 'stone',
    ceiling: null,
    floorTint: '#8e8c88',
    wallTint: '#807e7a',
    ceilingTint: '#ffffff',
    ambient: 0.42,
    ambientColor: '#aeb8c2',
    fogDensity: 0.025,
    fogColor: '#8e97a1',
    props: ['water'],
    seed: 97,
  },

  hades: {
    width: 15,
    depth: 15,
    height: 7,
    floor: 'rough-stone',
    walls: 'rough-stone',
    ceiling: 'rough-stone',
    floorTint: '#4a4448',
    wallTint: '#453f45',
    ceilingTint: '#2e2a2e',
    // A dim, sourceless red that is not the lantern — the one place in the
    // game that is lit and still feels worse for it.
    ambient: 0.14,
    ambientColor: '#8c3a34',
    fogDensity: 0.055,
    fogColor: '#170a0a',
    props: ['gravestones', 'stalactites'],
    seed: 101,
  },

  /** Rooms holding something worth the trip. Taller, cleaner, colder. */
  vault: {
    width: 12,
    depth: 12,
    height: 6.5,
    floor: 'marble',
    walls: 'stone',
    ceiling: 'stone',
    floorTint: '#8e8a80',
    wallTint: '#7c786f',
    ceilingTint: '#565249',
    ambient: 0.08,
    ambientColor: '#7d88a0',
    fogDensity: 0.05,
    fogColor: '#0b0d12',
    props: [],
    seed: 103,
  },

  barrow: {
    width: 12,
    depth: 12,
    height: 6,
    floor: 'earth',
    walls: 'stone',
    ceiling: null,
    floorTint: '#7c705e',
    wallTint: '#6e6a60',
    ceilingTint: '#ffffff',
    ambient: 0.4,
    ambientColor: '#b3a98f',
    fogDensity: 0.03,
    fogColor: '#9a927f',
    props: ['boulder'],
    seed: 107,
  },
};

/**
 * Classify a room by its name.
 *
 * Order matters: "Dam Base" must be tested before the generic "Dam", and
 * "Mirror Room" before "Room". The patterns are matched case-insensitively
 * against the room's printed name.
 */
const NAME_PATTERNS: [RegExp, RoomFamily][] = [
  [/^(forest|clearing|up a tree|forest path)/i, 'forest'],
  [/(west|north|south) of house|behind house/i, 'house-exterior'],
  [/^(kitchen|living room|attic|studio)$/i, 'house-interior'],
  [/^(cellar|east of chasm)$/i, 'cellar'],
  [/^(maze|dead end|grating room)$/i, 'maze'],
  [/(temple|altar|egyptian|torch room|dome room|tomb)/i, 'temple'],
  [/(coal mine|ladder|squeaky|smelly|mine entrance|machine room|drafty room|gas room|shaft room|bat room|timber room)/i, 'mine'],
  // Word-bounded, or this matches "Damp Cave" and floods a cave with daylight.
  [/\bdam\b/i, 'dam'],
  [/(river|stream|reservoir|beach|shore|sandy cave|white cliffs)/i, 'water'],

  // Named explicitly: "Deep Canyon" is underground and must fall through to
  // the cave pattern below rather than being opened to the sky.
  [/(canyon view|canyon bottom|rocky ledge|rainbow|aragain falls)/i, 'canyon'],
  [/(hades|land of the dead)/i, 'hades'],
  [/(treasure room|cyclops|gallery|atlantis|mirror room)/i, 'vault'],
  [/(stone barrow|barrow)/i, 'barrow'],
  [/(passage|crawlway|corridor|slide)/i, 'passage'],
  [/(cave|chasm|deep canyon|round room|loud room|engravings|maintenance|strange)/i, 'cave'],
];

export function classifyRoom(name: string, selfLit: boolean): RoomFamily {
  for (const [pattern, family] of NAME_PATTERNS) {
    if (!pattern.test(name)) continue;
    // A waterside room that lights itself is on the surface; the same name in
    // the dark is a cavern with an underground lake in it.
    if (family === 'water' && selfLit) return 'riverbank';
    return family;
  }
  // Anything unrecognised: a lit room is almost certainly outdoors in Zork I,
  // and an unlit one is almost certainly underground.
  return selfLit ? 'forest' : 'cave';
}

/**
 * Hand-tuned overrides for the places worth getting right.
 *
 * Each is a partial patch over the family style, so a room only states what
 * makes it different rather than repeating a whole palette.
 */
const BY_NAME: Record<string, Partial<RoomStyle>> = {
  'West of House': { props: ['house-facade', 'trees'], width: 20, seed: 201 },
  'Behind House': { props: ['house-facade'], seed: 202 },
  'North of House': { props: ['house-facade'], seed: 203 },
  'South of House': { props: ['house-facade'], seed: 204 },

  // The one room every player remembers: the rug, the trap door, the case.
  'Living Room': {
    width: 9,
    depth: 8,
    height: 3.4,
    floorTint: '#8f7454',
    wallTint: '#7d6450',
    ambient: 0.5,
    ambientColor: '#e0c193',
    seed: 205,
  },
  Kitchen: { width: 7.5, depth: 6.5, floorTint: '#a08a68', ambient: 0.42, seed: 206 },
  Attic: {
    height: 2.4,
    ambient: 0.02,
    fogDensity: 0.09,
    floorTint: '#6e5a44',
    wallTint: '#5e4c3c',
    seed: 207,
  },

  // Small, damp, and the first place the sword starts to glow.
  Cellar: { width: 9, depth: 9, seed: 208 },
  'The Troll Room': {
    width: 10,
    depth: 9,
    height: 4.5,
    wallTint: '#7a6a5e',
    floorTint: '#6a5a4a',
    props: ['rubble', 'stalactites'],
    seed: 209,
  },

  // "A circular stone room with passages in all directions."
  'Round Room': { width: 13, depth: 13, height: 5.5, props: ['stalactites'], seed: 210 },

  'Dome Room': {
    width: 16,
    depth: 16,
    height: 18,
    walls: 'stone',
    ceiling: 'stone',
    props: [],
    fogDensity: 0.04,
    seed: 211,
  },
  'Torch Room': {
    width: 13,
    depth: 13,
    height: 12,
    ambient: 0.3,
    ambientColor: '#e8a24a',
    fogColor: '#1a0f06',
    props: ['columns'],
    seed: 212,
  },
  Temple: { width: 14, depth: 20, height: 10, seed: 213 },
  Altar: { width: 12, depth: 12, height: 9, ambient: 0.2, seed: 214 },
  'Egyptian Room': { width: 10, depth: 10, height: 6, floor: 'sand', floorTint: '#9a8560', seed: 215 },

  'Entrance to Hades': { width: 14, depth: 14, seed: 216 },
  'Land of the Dead': { width: 18, depth: 18, ambient: 0.1, seed: 217 },

  'Cyclops Room': {
    width: 12,
    depth: 12,
    height: 7.5,
    floorTint: '#7a6f60',
    props: ['rubble'],
    seed: 218,
  },
  'Treasure Room': {
    width: 11,
    depth: 11,
    height: 5.5,
    ambient: 0.1,
    ambientColor: '#c8a460',
    seed: 219,
  },
  Gallery: { width: 10, depth: 9, height: 4.5, ambient: 0.12, seed: 220 },
  'Atlantis Room': { width: 10, depth: 10, seed: 221 },

  'Mirror Room': { width: 10, depth: 10, height: 5.5, props: ['mirror'], seed: 222 },

  Dam: { width: 20, depth: 12, props: ['water'], seed: 223 },
  'Dam Base': { width: 16, depth: 14, props: ['water'], seed: 224 },
  'Dam Lobby': { ceiling: 'stone', ambient: 0.3, fogDensity: 0.04, seed: 225 },
  'Maintenance Room': { width: 9, depth: 8, height: 3.4, walls: 'metal', wallTint: '#6a6e72', seed: 226 },

  Reservoir: { width: 20, depth: 16, props: ['water'], seed: 227 },
  'Reservoir North': { width: 14, depth: 12, props: ['water', 'sand-drift'], seed: 228 },
  'Reservoir South': { width: 14, depth: 12, props: ['water', 'sand-drift'], seed: 229 },

  'Loud Room': { width: 12, depth: 12, height: 6, props: ['stalactites'], seed: 230 },
  'Gas Room': {
    // The one room where striking a light is fatal. Sickly, and it should look it.
    ambientColor: '#7a8a4a',
    ambient: 0.05,
    fogColor: '#12160a',
    seed: 231,
  },
  'Coal Mine': { width: 7, depth: 7, height: 2.8, seed: 232 },
  'Drafty Room': { width: 6, depth: 6, height: 2.6, seed: 233 },
  'Machine Room': { width: 8, depth: 8, walls: 'metal', wallTint: '#5e6266', seed: 234 },

  'On the Rainbow': {
    width: 14,
    depth: 20,
    height: 20,
    ceiling: null,
    ambient: 0.7,
    ambientColor: '#d8dce4',
    fogDensity: 0.018,
    props: ['rainbow'],
    seed: 235,
  },
  'Aragain Falls': { width: 16, depth: 14, props: ['water', 'rainbow'], seed: 236 },
  'End of Rainbow': { width: 14, depth: 12, props: ['water', 'sand-drift'], seed: 237 },
  'Canyon View': { width: 16, depth: 12, height: 20, seed: 238 },
  'Canyon Bottom': { width: 14, depth: 12, height: 22, seed: 239 },

  'Stone Barrow': { seed: 240 },
  'Grating Room': { width: 7, depth: 7, height: 3.2, props: ['rubble'], seed: 241 },
  'Slide Room': { width: 9, depth: 9, height: 5, seed: 242 },
  'Studio': { floorTint: '#7e6a50', props: [], seed: 243 },
  'Engravings Cave': { width: 9, depth: 8, height: 3.6, seed: 244 },
  'Sandy Cave': { floor: 'sand', floorTint: '#9c8a64', props: ['sand-drift'], seed: 245 },
  'Sandy Beach': { props: ['water', 'sand-drift'], seed: 246 },
};

/**
 * Overrides keyed by object number, for rooms whose names repeat.
 *
 * The four Forests and the eleven Mazes are separate places that print the
 * same name, so a name lookup cannot tell them apart. Varying the seed is
 * enough to give the forests different trees while leaving the maze rooms
 * identical, which is the point of the maze.
 */
const BY_OBJECT: Record<number, Partial<RoomStyle>> = {
  76: { seed: 301 }, // Forest, west of the house
  77: { seed: 302 }, // Forest, east
  78: { seed: 303 }, // Forest, the dense one south
  239: { seed: 304 }, // Forest, up by the tree
  88: { height: 14, props: ['trees'], ambient: 0.6, seed: 305 }, // Up a Tree
  74: { width: 18, depth: 18, props: ['trees'], seed: 306 }, // Clearing, grating
  143: { width: 16, depth: 16, props: ['trees'], seed: 307 }, // Clearing, canyon
  // The two Mirror Rooms are meant to be indistinguishable, so they share a seed.
  150: { seed: 222 },
  152: { seed: 222 },
};

/**
 * Merge a family style with any overrides that apply to this room, then make
 * sure the result agrees with the game about the light.
 *
 * The final pass is a guard rather than art direction. A room the story file
 * says is dark must be styled dark and must have a ceiling, whatever family it
 * landed in and whatever an override asked for — otherwise the player arrives
 * in a well-lit room while the text tells them it is pitch black. The Studio is
 * the case that motivated it: its name puts it with the Kitchen and the Living
 * Room, but it is in the cellar and it is unlit.
 */
export function styleFor(objectNumber: number, name: string, selfLit: boolean): RoomStyle {
  const family = FAMILIES[classifyRoom(name, selfLit)];
  const style: RoomStyle = {
    ...family,
    ...(BY_NAME[name] ?? {}),
    ...(BY_OBJECT[objectNumber] ?? {}),
  };

  if (selfLit) return style;

  return {
    ...style,
    ambient: Math.min(style.ambient, 0.06),
    ambientColor: '#39424f',
    // An unlit room open to the sky is a contradiction; give it a roof made of
    // whatever its walls are.
    ceiling: style.ceiling ?? style.walls,
    ceilingTint: style.ceiling ? style.ceilingTint : style.wallTint,
    fogDensity: Math.max(style.fogDensity, 0.04),
  };
}

export { FAMILIES };
