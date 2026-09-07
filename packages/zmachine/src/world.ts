/**
 * Reading a running story as a world a renderer can draw.
 *
 * The interpreter knows about bytes. It does not know that property 31 means
 * "north" or that attribute 20 means "this is giving off light" — those are
 * conventions of the ZIL compiler and of the game itself, not of the Z-machine.
 * So this module takes a `StoryProfile` describing the mapping and turns the
 * live object tree into a `WorldSnapshot`: which room, which way out, what is
 * on the floor, what is in your hands.
 *
 * The important property of this design is that it only ever *reads*. Taking a
 * lamp is not something this module can do; it types "take lamp" at the parser
 * and lets the original code decide. So the snapshot can lag the game by no
 * more than a turn, and it can never disagree with it — if Infocom's code says
 * the grating is locked, no amount of renderer state can open it.
 *
 * The exit encoding is the one piece worth explaining. ZIL packs each
 * direction into a property whose *length* is its type:
 *
 *   1 byte   go there, unconditionally
 *   2 bytes  you cannot go that way, and here is the sentence saying so
 *   3 bytes  ask a routine at run time (the trap door, the chimney)
 *   4 bytes  go there if a global flag is set, else print the message
 *   5 bytes  go there if a door object is open, else print the message
 *
 * Lengths 4 and 5 are why a renderer can honestly draw a doorway as barred or
 * open without simulating anything: the condition is a flag or an attribute
 * that can simply be read.
 */

import type { Machine } from './machine.js';
import { decodeString } from './text.js';

export type Direction =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northeast'
  | 'northwest'
  | 'southeast'
  | 'southwest'
  | 'up'
  | 'down'
  | 'in'
  | 'out';

/** Every direction, in the order a compass rose would list them. */
export const DIRECTIONS: readonly Direction[] = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
  'up',
  'down',
  'in',
  'out',
];

/**
 * How one story file names the concepts this reader needs.
 *
 * These numbers are not part of the Z-machine standard; they are whatever the
 * compiler assigned when the game was built. They were recovered from the
 * story file by inspection rather than copied from a reference, and the tests
 * re-derive the important ones so a wrong number fails loudly.
 */
export interface StoryProfile {
  name: string;
  /** Guards against pointing the profile at a story file it does not describe. */
  release: number;
  serial: string;
  playerObject: number;
  directionProperties: Readonly<Record<Direction, number>>;
  properties: {
    /** Bulk, which the game weighs against the carry limit. */
    size: number;
    /** Points for taking the object, or for entering the room. */
    value: number;
    /** Extra points for depositing a treasure in the trophy case. */
    trophyValue: number;
    /** How much a container holds. */
    capacity: number;
    /** Objects present in a room as scenery rather than as contents. */
    scenery: number;
    /** Packed address of the object's long description. */
    longDescription: number;
  };
  attributes: {
    touched: number;
    open: number;
    takeable: number;
    container: number;
    providesLight: number;
    actor: number;
    transparent: number;
  };
  globals: {
    location: number;
    score: number;
    moves: number;
    /** Set by the game whenever the player's location is lit. */
    lit: number;
    carryLimit: number;
  };
}

export interface ObjectView {
  number: number;
  name: string;
  /** Bulk, falling back to the story's default when undeclared, as the game does. */
  size: number;
  takeable: boolean;
  container: boolean;
  open: boolean;
  transparent: boolean;
  actor: boolean;
  providesLight: boolean;
  touched: boolean;
  /** Contents, present when the container is open or see-through. */
  contents: ObjectView[];
}

export type Exit =
  | { direction: Direction; kind: 'plain'; to: number; toName: string }
  | { direction: Direction; kind: 'blocked'; message: string }
  | {
      direction: Direction;
      kind: 'conditional';
      to: number;
      toName: string;
      passable: boolean;
      message: string;
    }
  | {
      direction: Direction;
      kind: 'door';
      to: number;
      toName: string;
      door: number;
      doorName: string;
      passable: boolean;
      message: string;
    }
  | { direction: Direction; kind: 'computed' };

export interface WorldSnapshot {
  room: {
    number: number;
    name: string;
    visited: boolean;
    /** Inherently lit, independent of whether the player carries a lamp. */
    selfLit: boolean;
  };
  /** False when the player is in the dark and a grue is a live possibility. */
  lit: boolean;
  exits: Exit[];
  /** Objects lying in the room, excluding the player. */
  contents: ObjectView[];
  /** Scenery the room declares: the white house, the stairs, the chimney. */
  scenery: ObjectView[];
  inventory: ObjectView[];
  carried: {
    /** Sum of the sizes of everything held, which is what the limit weighs. */
    bulk: number;
    limit: number;
  };
  score: number;
  moves: number;
}

export class WorldReader {
  constructor(
    private readonly machine: Machine,
    readonly profile: StoryProfile,
  ) {
    const { memory } = machine;
    if (memory.release !== profile.release || memory.serial !== profile.serial) {
      throw new Error(
        `Profile "${profile.name}" describes release ${profile.release}/${profile.serial}, ` +
          `but the story file is release ${memory.release}/${memory.serial}. ` +
          `Property numbers differ between releases, so this would silently misread the world.`,
      );
    }
  }

  private get objects() {
    return this.machine.objects;
  }

  /** The object the player currently occupies, read from the reserved global. */
  get location(): number {
    return this.machine.memory.getGlobal(this.profile.globals.location);
  }

  private view(obj: number, depth = 0): ObjectView {
    const { attributes, properties } = this.profile;
    const has = (attr: number) => this.objects.testAttribute(obj, attr);

    const open = has(attributes.open);
    const transparent = has(attributes.transparent);
    const container = has(attributes.container);

    // Recursing into a closed, opaque container would report things the player
    // cannot see. The depth cap is a guard against a cycle in a corrupt tree.
    const canSeeInside = container && (open || transparent);
    const contents =
      canSeeInside && depth < 4
        ? this.objects.getChildren(obj).map((child) => this.view(child, depth + 1))
        : [];

    return {
      number: obj,
      name: this.objects.getName(obj),
      // Size goes through the property default deliberately. Most portable
      // objects in Zork I do not declare one, and the game weighs those as the
      // default of 5 rather than as weightless — the bottle and the clove of
      // garlic really do count against the load. Reading the raw property
      // instead would under-report what the player is carrying.
      size: this.objects.getProperty(obj, properties.size),
      takeable: has(attributes.takeable),
      container,
      open,
      transparent,
      actor: has(attributes.actor),
      providesLight: has(attributes.providesLight),
      touched: has(attributes.touched),
      contents,
    };
  }

  /** Decode the exit stored in one direction property of a room. */
  private readExit(room: number, direction: Direction): Exit | undefined {
    const property = this.profile.directionProperties[direction];
    const entry = this.objects.findProperty(room, property);
    if (!entry) return undefined;

    const { memory } = this.machine;
    const byteAt = (offset: number) => memory.getByte(entry.dataAddr + offset);
    const wordAt = (offset: number) => memory.getWord(entry.dataAddr + offset);
    const stringAt = (packed: number) =>
      packed === 0 ? '' : decodeString(memory, memory.unpack(packed)).text;

    switch (entry.length) {
      case 1: {
        const to = byteAt(0);
        return { direction, kind: 'plain', to, toName: this.objects.getName(to) };
      }
      case 2:
        return { direction, kind: 'blocked', message: stringAt(wordAt(0)) };
      case 3:
        // The destination comes out of a routine, so it cannot be known
        // without running the game. The renderer draws an opening and lets
        // the parser decide what happens.
        return { direction, kind: 'computed' };
      case 4: {
        const to = byteAt(0);
        // Byte 1 is a variable number, not a global index; globals begin at 16.
        const variable = byteAt(1);
        const passable = memory.getGlobal(variable - 16) !== 0;
        return {
          direction,
          kind: 'conditional',
          to,
          toName: this.objects.getName(to),
          passable,
          message: stringAt(wordAt(2)),
        };
      }
      case 5: {
        const to = byteAt(0);
        const door = byteAt(1);
        return {
          direction,
          kind: 'door',
          to,
          toName: this.objects.getName(to),
          door,
          doorName: this.objects.getName(door),
          passable: this.objects.testAttribute(door, this.profile.attributes.open),
          message: stringAt(wordAt(2)),
        };
      }
      default:
        return { direction, kind: 'computed' };
    }
  }

  /** Objects a room lists as scenery, stored as a run of object numbers. */
  private readScenery(room: number): ObjectView[] {
    const entry = this.objects.findProperty(room, this.profile.properties.scenery);
    if (!entry) return [];

    const views: ObjectView[] = [];
    for (let i = 0; i < entry.length; i += 1) {
      const obj = this.machine.memory.getByte(entry.dataAddr + i);
      if (obj !== 0) views.push(this.view(obj));
    }
    return views;
  }

  snapshot(): WorldSnapshot {
    const { globals, attributes, playerObject } = this.profile;
    const { memory } = this.machine;
    const room = this.location;

    const exits: Exit[] = [];
    for (const direction of DIRECTIONS) {
      const exit = room === 0 ? undefined : this.readExit(room, direction);
      if (exit) exits.push(exit);
    }

    const contents =
      room === 0
        ? []
        : this.objects
            .getChildren(room)
            .filter((child) => child !== playerObject)
            .map((child) => this.view(child));

    const inventory = this.objects.getChildren(playerObject).map((obj) => this.view(obj));

    // The limit weighs the bulk of everything held, including things inside
    // containers the player is carrying, which is how a full sack still counts.
    const bulkOf = (views: ObjectView[]): number =>
      views.reduce((total, item) => total + item.size + bulkOf(item.contents), 0);

    return {
      room: {
        number: room,
        name: room === 0 ? '' : this.objects.getName(room),
        visited: room !== 0 && this.objects.testAttribute(room, attributes.touched),
        selfLit: room !== 0 && this.objects.testAttribute(room, attributes.providesLight),
      },
      lit: memory.getGlobal(globals.lit) !== 0,
      exits,
      contents,
      scenery: room === 0 ? [] : this.readScenery(room),
      inventory,
      carried: { bulk: bulkOf(inventory), limit: memory.getGlobal(globals.carryLimit) },
      score: memory.getGlobal(globals.score),
      moves: memory.getGlobal(globals.moves),
    };
  }
}
