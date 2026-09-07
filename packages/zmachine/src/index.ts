/**
 * A Z-machine version 3 interpreter, and the world-state reader built on it.
 *
 * The interpreter runs an unmodified Infocom story file. The reader turns the
 * machine's live object tree into something a renderer can draw. Nothing in
 * this package knows anything about Zork specifically — point it at any v3
 * story file and it will run.
 */

export { Memory, Header, Flags1, toSigned, toUnsigned } from './memory.js';
export { ObjectTable, MAX_OBJECTS_V3 } from './objects.js';
export type { PropertyEntry } from './objects.js';
export { Dictionary } from './dictionary.js';
export type { Token } from './dictionary.js';
export {
  decodeString,
  decodeZChars,
  encodeWord,
  packZChars,
  readZChars,
  DICT_ZCHARS_V3,
} from './text.js';
export { Machine } from './machine.js';
export type { MachineHooks, RunResult, StatusLine } from './machine.js';
export { WorldReader, DIRECTIONS } from './world.js';
export type {
  Direction,
  Exit,
  ObjectView,
  StoryProfile,
  WorldSnapshot,
} from './world.js';
export { ZORK1_R88 } from './zork1.js';
