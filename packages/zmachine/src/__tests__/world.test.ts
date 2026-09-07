/**
 * World-reader tests.
 *
 * These do more than check the reader: they re-derive the Zork I profile's
 * property and attribute numbers from the story file, so if the profile is
 * ever pointed at a different build the suite says which number moved instead
 * of the renderer quietly drawing the wrong room.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Machine } from '../machine.js';
import { WorldReader } from '../world.js';
import type { WorldSnapshot } from '../world.js';
import { ZORK1_R88 } from '../zork1.js';

const here = dirname(fileURLToPath(import.meta.url));
const STORY_PATH = resolve(here, '../../stories/zork1-r88-s840726.z3');
const hasStory = existsSync(STORY_PATH);

/** A machine plus reader, driven to a given position. */
function playTo(moves: string[], seed = 31337) {
  const image = new Uint8Array(readFileSync(STORY_PATH));
  let output = '';
  const machine = new Machine(image, { onOutput: (t) => (output += t) }, seed);
  const reader = new WorldReader(machine, ZORK1_R88);

  for (const move of moves) {
    machine.run();
    machine.provideInput(move);
  }
  machine.run();

  return {
    machine,
    reader,
    snapshot: reader.snapshot(),
    get output() {
      return output;
    },
    step(move: string): WorldSnapshot {
      machine.provideInput(move);
      machine.run();
      return reader.snapshot();
    },
  };
}

const names = (items: { name: string }[]) => items.map((i) => i.name).sort();

describe.skipIf(!hasStory)('WorldReader against Zork I', () => {
  it('refuses a profile that does not match the story file', () => {
    const machine = new Machine(new Uint8Array(readFileSync(STORY_PATH)), {}, 1);
    expect(() => new WorldReader(machine, { ...ZORK1_R88, release: 87 })).toThrow(
      /release 87/,
    );
  });

  it('reads the opening room, its contents and its exits', () => {
    const { snapshot } = playTo([]);

    expect(snapshot.room.name).toBe('West of House');
    expect(snapshot.room.selfLit).toBe(true);
    expect(snapshot.lit).toBe(true);
    expect(names(snapshot.contents)).toContain('small mailbox');

    // The mailbox is a closed container, so its contents must not be visible.
    const mailbox = snapshot.contents.find((o) => o.name === 'small mailbox')!;
    expect(mailbox.container).toBe(true);
    expect(mailbox.open).toBe(false);
    expect(mailbox.contents).toEqual([]);

    const north = snapshot.exits.find((e) => e.direction === 'north');
    expect(north).toMatchObject({ kind: 'plain', toName: 'North of House' });
  });

  it('reveals a container’s contents only once it is open', () => {
    const session = playTo([]);
    const after = session.step('open mailbox');
    const mailbox = after.contents.find((o) => o.name === 'small mailbox')!;

    expect(mailbox.open).toBe(true);
    expect(names(mailbox.contents)).toEqual(['leaflet']);
  });

  it('reports the boarded east door as blocked, with the original sentence', () => {
    const { snapshot } = playTo([]);
    const east = snapshot.exits.find((e) => e.direction === 'east');

    expect(east?.kind).toBe('blocked');
    if (east?.kind === 'blocked') {
      expect(east.message).toContain('boarded');
    }
  });

  it('tracks a door exit opening, which is how the window is drawn', () => {
    const session = playTo(['n', 'e']);

    const closed = session.snapshot.exits.find((e) => e.direction === 'west');
    expect(closed).toMatchObject({
      kind: 'door',
      toName: 'Kitchen',
      doorName: 'kitchen window',
      passable: false,
    });

    const opened = session.step('open window');
    const west = opened.exits.find((e) => e.direction === 'west');
    expect(west).toMatchObject({ kind: 'door', passable: true });
  });

  it('follows the player into the house and reads the new room', () => {
    const { snapshot } = playTo(['n', 'e', 'open window', 'enter window']);

    expect(snapshot.room.name).toBe('Kitchen');
    expect(snapshot.score).toBe(10);

    // The sack and the bottle are *on the table*, not on the floor, so they
    // are nested one level down. The table is an open, transparent container,
    // which is what makes them visible at all.
    expect(names(snapshot.contents)).toEqual(['kitchen table']);
    const table = snapshot.contents[0]!;
    expect(table.container).toBe(true);
    expect(names(table.contents)).toEqual(['brown sack', 'glass bottle']);

    // The kitchen declares the window and the staircase as scenery rather than
    // as things lying on the floor.
    expect(names(snapshot.scenery).length).toBeGreaterThan(0);
  });

  it('moves an object from the room into the inventory when it is taken', () => {
    const session = playTo(['n', 'e', 'open window', 'enter window', 'w']);
    expect(names(session.snapshot.inventory)).toEqual([]);

    const after = session.step('take lamp');
    expect(names(after.inventory)).toEqual(['brass lantern']);
    expect(names(after.contents)).not.toContain('brass lantern');
  });

  it('reads bulk from the size property and totals what is carried', () => {
    const session = playTo(['n', 'e', 'open window', 'enter window', 'w', 'take lamp']);
    const lamp = session.snapshot.inventory.find((o) => o.name === 'brass lantern')!;

    expect(lamp.size).toBe(15);
    expect(session.snapshot.carried.bulk).toBe(15);
    expect(session.snapshot.carried.limit).toBe(100);

    const after = session.step('take sword');
    expect(after.carried.bulk).toBe(45); // lantern 15 + sword 30
  });

  it('sees the lamp light up and go dark again', () => {
    const session = playTo(['n', 'e', 'open window', 'enter window', 'w', 'take lamp']);
    const off = session.snapshot.inventory[0]!;
    expect(off.providesLight).toBe(false);

    const on = session.step('turn on lamp');
    expect(on.inventory[0]!.providesLight).toBe(true);
  });

  it('reports darkness in the cellar exactly when the game does', () => {
    const session = playTo([
      'n', 'e', 'open window', 'enter window', 'w',
      'take lamp', 'move rug', 'open trap door', 'turn on lamp', 'down',
    ]);

    expect(session.snapshot.room.name).toBe('Cellar');
    expect(session.snapshot.room.selfLit).toBe(false);
    expect(session.snapshot.lit).toBe(true); // the lamp is doing the work

    const dark = session.step('turn off lamp');
    expect(dark.lit).toBe(false);

    const relit = session.step('turn on lamp');
    expect(relit.lit).toBe(true);
  });

  it('sees the troll as an actor standing in the room', () => {
    const session = playTo([
      'n', 'e', 'open window', 'enter window', 'w',
      'take lamp', 'take sword', 'move rug', 'open trap door',
      'turn on lamp', 'down', 'n',
    ]);

    expect(session.snapshot.room.name).toBe('The Troll Room');
    const troll = session.snapshot.contents.find((o) => o.name === 'troll');
    expect(troll?.actor).toBe(true);
  });

  it('marks a room as visited only after the player has been there', () => {
    const session = playTo([]);
    expect(session.snapshot.room.visited).toBe(true);

    const north = session.step('n');
    expect(north.room.name).toBe('North of House');
    expect(north.room.visited).toBe(true);
  });

  it('exposes a conditional exit and whether its flag is currently set', () => {
    // West of House has a south-west exit to the Stone Barrow that only opens
    // at the very end of the game, so it must read as impassable at the start.
    const { snapshot } = playTo([]);
    const sw = snapshot.exits.find((e) => e.direction === 'southwest');

    expect(sw?.kind).toBe('conditional');
    if (sw?.kind === 'conditional') {
      expect(sw.toName).toBe('Stone Barrow');
      expect(sw.passable).toBe(false);
    }
  });
});

describe.skipIf(!hasStory)('the Zork I profile is derived, not assumed', () => {
  const machineFor = () => new Machine(new Uint8Array(readFileSync(STORY_PATH)), {}, 1);

  /** Every object, indexed by its printed name. */
  function index(machine: Machine): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 1; i <= machine.objects.countObjects(); i += 1) {
      const name = machine.objects.getName(i);
      if (name && !map.has(name)) map.set(name, i);
    }
    return map;
  }

  it('direction properties point where the map says they should', () => {
    const machine = machineFor();
    const objects = index(machine);
    const { objects: table } = machine;
    const dirs = ZORK1_R88.directionProperties;

    const westOfHouse = objects.get('West of House')!;
    const exitTo = (room: number, property: number) =>
      table.getName(machine.memory.getByte(table.findProperty(room, property)!.dataAddr));

    expect(exitTo(westOfHouse, dirs.north)).toBe('North of House');
    expect(exitTo(westOfHouse, dirs.south)).toBe('South of House');
    expect(exitTo(westOfHouse, dirs.west)).toBe('Forest');

    const kitchen = objects.get('Kitchen')!;
    expect(exitTo(kitchen, dirs.up)).toBe('Attic');
    expect(exitTo(kitchen, dirs.west)).toBe('Living Room');
  });

  it('the value property holds the points each room is worth', () => {
    const machine = machineFor();
    const objects = index(machine);
    const read = (room: number) =>
      machine.memory.getWord(
        machine.objects.findProperty(room, ZORK1_R88.properties.value)!.dataAddr,
      );

    // These are the two the opening moves demonstrate: 10 for the house, 25
    // for the cellar, which is the 35 the score shows after descending.
    expect(read(objects.get('Kitchen')!)).toBe(10);
    expect(read(objects.get('Cellar')!)).toBe(25);
  });

  it('the size property gives the familiar ordering of bulk', () => {
    const machine = machineFor();
    const objects = index(machine);
    const size = (name: string) =>
      machine.memory.getWord(
        machine.objects.findProperty(objects.get(name)!, ZORK1_R88.properties.size)!
          .dataAddr,
      );

    expect(size('gold coffin')).toBe(55);
    expect(size('sword')).toBe(30);
    expect(size('brass lantern')).toBe(15);
    expect(size('leaflet')).toBe(2);
  });

  it('the player object is the one that receives what you pick up', () => {
    const image = new Uint8Array(readFileSync(STORY_PATH));
    const machine = new Machine(image, {}, 1);
    for (const move of ['open mailbox', 'take leaflet']) {
      machine.run();
      machine.provideInput(move);
    }
    machine.run();

    const leaflet = index(machine).get('leaflet')!;
    expect(machine.objects.getParent(leaflet)).toBe(ZORK1_R88.playerObject);
  });

  it('weighs undeclared objects at the story default, as the game does', () => {
    // The bottle, the lunch and the clove of garlic declare no size, so the
    // default of 5 is their real weight. A reader that treated a missing
    // property as weightless would tell the player they are carrying far less
    // than the game thinks they are.
    const machine = machineFor();
    expect(machine.objects.getPropertyDefault(ZORK1_R88.properties.size)).toBe(5);

    const objects = index(machine);
    const bottle = objects.get('glass bottle')!;
    expect(machine.objects.findProperty(bottle, ZORK1_R88.properties.size)).toBeUndefined();
    expect(machine.objects.getProperty(bottle, ZORK1_R88.properties.size)).toBe(5);
  });

  it('sees the load allowance fall when the troll wounds the player', () => {
    // Zork I's carry limit is not a constant: a wound reduces it. Standing in
    // the Troll Room without fighting back is the shortest way to prove the
    // profile is reading the right global, because the number moves on exactly
    // the turn the player is injured.
    const image = new Uint8Array(readFileSync(STORY_PATH));
    let output = '';
    const machine = new Machine(image, { onOutput: (t) => (output += t) }, 424242);
    const reader = new WorldReader(machine, ZORK1_R88);

    const step = (move: string) => {
      machine.run();
      machine.provideInput(move);
      machine.run();
    };

    for (const move of [
      'n', 'e', 'open window', 'enter window', 'w',
      'take lamp', 'take sword', 'move rug', 'open trap door',
      'turn on lamp', 'down', 'n',
    ]) {
      step(move);
    }
    expect(reader.snapshot().room.name).toBe('The Troll Room');
    expect(reader.snapshot().carried.limit).toBe(100);

    // Let the troll swing until it connects.
    for (let turn = 0; turn < 12; turn += 1) {
      step('wait');
      if (reader.snapshot().carried.limit < 100) break;
    }

    expect(reader.snapshot().carried.limit).toBe(90);

    output = '';
    step('diagnose');
    expect(output).toMatch(/wound/i);
  });

  it('leaves capacity limits to the story file, which still enforces them', () => {
    // Nothing in this package implements a limit. The sack holds 15 and the
    // sword is 30, and it is Infocom's code that says no — which is the whole
    // reason the world is read rather than reimplemented.
    let output = '';
    const machine = new Machine(
      new Uint8Array(readFileSync(STORY_PATH)),
      { onOutput: (t) => (output += t) },
      1,
    );
    const moves = [
      'n', 'e', 'open window', 'enter window',
      'take sack', 'open sack', 'w', 'take sword', 'put sword in sack',
    ];
    for (const move of moves) {
      machine.run();
      machine.provideInput(move);
    }
    machine.run();

    expect(output).toMatch(/no room|won't fit|too big/i);
  });
});
