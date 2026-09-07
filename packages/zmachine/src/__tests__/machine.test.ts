/**
 * Interpreter tests.
 *
 * The unit tests below build tiny synthetic story images so that a failure
 * points at one opcode rather than at "Zork is broken". The transcript tests
 * then run the real story file, because a v3 interpreter can pass every unit
 * test and still be unable to get past the troll.
 *
 * The story file is copyrighted and is therefore not in the repository. Tests
 * that need it skip themselves when it is absent, so a clean checkout still
 * gets a green run; drop `zork1-r88-s840726.z3` into `stories/` to enable them.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Machine } from '../machine.js';
import { Memory } from '../memory.js';
import { encodeWord, packZChars, decodeString } from '../text.js';

const here = dirname(fileURLToPath(import.meta.url));
const STORY_PATH = resolve(here, '../../stories/zork1-r88-s840726.z3');
const hasStory = existsSync(STORY_PATH);

/**
 * Assemble a minimal but structurally valid v3 image.
 *
 * Every table the interpreter touches on startup has to exist, even when a
 * test does not care about it, or construction fails before the test begins.
 */
function buildImage(options: {
  /** Defaults to a lone `quit`, for tests that only inspect tables. */
  code?: number[];
  /** Object entries as [attributes(4), parent, sibling, child, propAddrHi/Lo]. */
  objects?: { attributes?: number[]; parent?: number; sibling?: number; child?: number }[];
  globals?: number[];
}): Uint8Array {
  const OBJ_TABLE = 0x0100;
  const GLOBALS = 0x0400;
  const DICT = 0x0600;
  const ABBREV = 0x0700;
  const CODE = 0x0800;

  const image = new Uint8Array(0x2000);
  const view = new DataView(image.buffer);

  view.setUint8(0x00, 3);
  view.setUint16(0x04, CODE); // high memory base
  view.setUint16(0x06, CODE); // initial PC
  view.setUint16(0x08, DICT);
  view.setUint16(0x0a, OBJ_TABLE);
  view.setUint16(0x0c, GLOBALS);
  view.setUint16(0x0e, 0x0800); // static base: everything below is writable
  view.setUint16(0x18, ABBREV);
  view.setUint16(0x1a, image.length / 2);

  // Object table: 31 words of defaults, then the entries.
  const objects = options.objects ?? [];
  const treeStart = OBJ_TABLE + 62;
  // Property tables go after the tree; the interpreter infers the object count
  // from where the first one starts, so this address defines the table size.
  const propBase = treeStart + Math.max(objects.length, 1) * 9;

  objects.forEach((obj, index) => {
    const entry = treeStart + index * 9;
    const attrs = obj.attributes ?? [0, 0, 0, 0];
    for (let i = 0; i < 4; i += 1) view.setUint8(entry + i, attrs[i] ?? 0);
    view.setUint8(entry + 4, obj.parent ?? 0);
    view.setUint8(entry + 5, obj.sibling ?? 0);
    view.setUint8(entry + 6, obj.child ?? 0);
    // A property table with an empty name and no properties.
    const propAddr = propBase + index * 4;
    view.setUint16(entry + 7, propAddr);
    view.setUint8(propAddr, 0); // name length in words
    view.setUint8(propAddr + 1, 0); // property list terminator
  });
  if (objects.length === 0) {
    view.setUint16(treeStart + 7, propBase);
  }

  (options.globals ?? []).forEach((value, index) => {
    view.setUint16(GLOBALS + index * 2, value);
  });

  // An empty dictionary: no separators, 4-byte entries, zero of them.
  view.setUint8(DICT, 0);
  view.setUint8(DICT + 1, 4);
  view.setUint16(DICT + 2, 0);

  // The code is entered as a routine, so it needs a locals count byte.
  // In v3 the initial PC is the address of the first instruction, not of a
  // routine, so there is no locals-count byte here. Writing one would be read
  // as opcode 0 and halt immediately.
  (options.code ?? [0xba]).forEach((byte, index) =>
    view.setUint8(CODE + index, byte),
  );

  return image;
}

/** Run an image and collect everything it prints. */
function runCollecting(image: Uint8Array): string {
  let output = '';
  const machine = new Machine(image, { onOutput: (text) => (output += text) }, 1);
  machine.run(100_000);
  return output;
}

describe('text encoding', () => {
  it('pads short words with shift-to-A2 rather than zeroes', () => {
    // Infocom's encoder used 5 as filler. Padding with 0 produces a probe that
    // never matches a real dictionary entry.
    expect(encodeWord('cat')).toEqual([8, 6, 25, 5, 5, 5]);
  });

  it('truncates at six Z-characters, which is why v3 confuses long words', () => {
    expect(encodeWord('disassemble')).toEqual(encodeWord('disassembly'));
  });

  it('shifts into the punctuation alphabet for a digit', () => {
    // '1' is A2 position 3, so Z-character 9, preceded by the shift.
    expect(encodeWord('1')).toEqual([5, 9, 5, 5, 5, 5]);
  });

  it('sets the terminator bit on the last word only', () => {
    const words = packZChars(encodeWord('cat'));
    expect(words).toHaveLength(2);
    expect(words[0]! & 0x8000).toBe(0);
    expect(words[1]! & 0x8000).toBe(0x8000);
  });
});

describe('arithmetic opcodes', () => {
  /**
   * Hand-assembled 2OP instruction in variable form.
   *
   * Long form cannot encode a large constant, and these tests need negative
   * numbers, so every one of them goes through the variable form: opcode byte
   * 0xC0 | opcode, then a types byte reading two bits per operand from bit 7
   * downwards. 0x1F is [large, small, omitted, omitted].
   */
  function binaryOp(opcode: number, a: number, b: number): number[] {
    return [
      0xc0 | opcode,
      0x1f,
      (a >> 8) & 0xff,
      a & 0xff,
      b & 0xff,
      0x00, // store into the stack
      0xe6, 0xbf, 0x00, // print_num stack
      0xba, // quit
    ];
  }

  it('treats operands as signed 16-bit', () => {
    // add -1, 1
    expect(runCollecting(buildImage({ code: binaryOp(20, 0xffff, 1) }))).toBe('0');
  });

  it('truncates division toward zero, not toward negative infinity', () => {
    // -7 / 2 is -3 in the Z-machine, where a floored division would give -4.
    expect(runCollecting(buildImage({ code: binaryOp(23, 0xfff9, 2) }))).toBe('-3');
  });

  it('gives the remainder the sign of the dividend', () => {
    expect(runCollecting(buildImage({ code: binaryOp(24, 0xfff9, 2) }))).toBe('-1');
  });

  it('multiplies with wraparound at 16 bits', () => {
    // 1000 * 232 is 232000, which does not fit. The Z-machine keeps the low
    // word and reads it back as signed: 35392 - 65536 = -30144.
    expect(runCollecting(buildImage({ code: binaryOp(22, 1000, 0xe8) }))).toBe('-30144');
  });
});

describe('object tree', () => {
  it('unlinks a middle child without breaking the sibling chain', () => {
    // Object 1 contains 2 -> 3 -> 4. Removing 3 must leave 2 -> 4.
    const image = buildImage({
      objects: [
        { child: 2 },
        { parent: 1, sibling: 3 },
        { parent: 1, sibling: 4 },
        { parent: 1, sibling: 0 },
      ],
    });
    const machine = new Machine(image, {}, 1);
    const { objects } = machine;

    expect(objects.getChildren(1)).toEqual([2, 3, 4]);
    objects.removeObject(3);
    expect(objects.getChildren(1)).toEqual([2, 4]);
    expect(objects.getParent(3)).toBe(0);
  });

  it('inserts at the front of the child list', () => {
    const image = buildImage({
      objects: [{ child: 2 }, { parent: 1 }, {}],
    });
    const machine = new Machine(image, {}, 1);

    machine.objects.insertObject(3, 1);
    expect(machine.objects.getChildren(1)).toEqual([3, 2]);
  });

  it('numbers attributes from the most significant bit', () => {
    // Attribute 0 is 0x80 of the first byte; attribute 8 is 0x80 of the second.
    const image = buildImage({ objects: [{ attributes: [0x80, 0x80, 0, 0] }] });
    const machine = new Machine(image, {}, 1);

    expect(machine.objects.testAttribute(1, 0)).toBe(true);
    expect(machine.objects.testAttribute(1, 8)).toBe(true);
    expect(machine.objects.testAttribute(1, 1)).toBe(false);

    machine.objects.setAttribute(1, 31);
    expect(machine.objects.testAttribute(1, 31)).toBe(true);
    machine.objects.clearAttribute(1, 0);
    expect(machine.objects.testAttribute(1, 0)).toBe(false);
  });
});

describe('memory', () => {
  it('refuses a write into static memory', () => {
    const image = buildImage({ code: [0xba] });
    const memory = new Memory(image);
    expect(() => memory.setByte(memory.staticBase, 1)).toThrow(/static memory/);
  });

  it('rejects a story file that is not version 3', () => {
    const image = buildImage({ code: [0xba] });
    image[0] = 5;
    expect(() => new Memory(image)).toThrow(/version 3/);
  });
});

describe.skipIf(!hasStory)('Zork I, the real story file', () => {
  const image = () => new Uint8Array(readFileSync(STORY_PATH));

  /** Play a list of commands and return the full transcript. */
  function play(moves: string[], seed = 4242): string {
    let output = '';
    const machine = new Machine(image(), { onOutput: (t) => (output += t) }, seed);

    for (const move of moves) {
      const result = machine.run();
      if (result.kind !== 'input') break;
      machine.provideInput(move);
    }
    machine.run();
    return output;
  }

  it('loads with the expected release, serial and checksum', () => {
    const machine = new Machine(image(), {}, 1);
    expect(machine.memory.release).toBe(88);
    expect(machine.memory.serial).toBe('840726');
    expect(machine.memory.verifyChecksum()).toBe(true);
    expect(machine.objects.countObjects()).toBe(250);
  });

  it('prints the opening banner and the first room', () => {
    const transcript = play([]);
    expect(transcript).toContain('ZORK I: The Great Underground Empire');
    expect(transcript).toContain('West of House');
    expect(transcript).toContain('There is a small mailbox here.');
  });

  it('decodes abbreviations inside room descriptions', () => {
    // The leaflet's text is dense with abbreviated words; a shift or
    // abbreviation bug garbles it in a way plain room names would not show.
    const transcript = play(['open mailbox', 'read leaflet']);
    expect(transcript).toContain('WELCOME TO ZORK');
    expect(transcript).toContain('a game of adventure, danger, and low cunning');
  });

  it('scores the entry into the house exactly as the original does', () => {
    let status = { score: 0, turns: 0, roomName: '' };
    let output = '';
    const machine = new Machine(
      image(),
      {
        onOutput: (t) => (output += t),
        onStatus: (s) => {
          status = { score: s.score, turns: s.turns, roomName: s.roomName };
        },
      },
      1,
    );

    for (const move of ['n', 'e', 'open window', 'enter window']) {
      machine.run();
      machine.provideInput(move);
    }
    machine.run();

    expect(status.roomName).toBe('Kitchen');
    expect(status.score).toBe(10);
    expect(output).toContain('elongated brown sack');
  });

  it('enforces darkness and the grue when the lamp is off', () => {
    const transcript = play([
      'n', 'e', 'open window', 'enter window', 'w',
      'take lamp', 'move rug', 'open trap door', 'down',
    ]);
    expect(transcript).toContain('pitch black');
    expect(transcript).toContain('grue');
  });

  it('runs the troll fight and bars the trap door behind the player', () => {
    const transcript = play([
      'n', 'e', 'open window', 'enter window', 'w',
      'take lamp', 'take sword', 'move rug', 'open trap door',
      'turn on lamp', 'down',
    ]);
    expect(transcript).toContain('The trap door crashes shut');
    expect(transcript).toContain('Cellar');
    expect(transcript).toContain('Your sword is glowing with a faint blue glow');
  });

  it('round-trips a save through the v3 branch-on-restore semantics', () => {
    let output = '';
    let saved: Uint8Array | undefined;
    const machine = new Machine(
      image(),
      {
        onOutput: (t) => (output += t),
        onSave: (data) => {
          saved = data;
          return true;
        },
        onRestore: () => saved,
      },
      7,
    );

    const moves = ['n', 'e', 'open window', 'enter window', 'save', 'w', 'e', 'restore', 'look'];
    for (const move of moves) {
      machine.run();
      machine.provideInput(move);
    }
    machine.run();

    expect(saved).toBeDefined();
    // Both the save and the restore report through the same line of Infocom's
    // code, so "Ok." must appear twice.
    expect(output.match(/Ok\./g)?.length).toBeGreaterThanOrEqual(2);
    // The restore must land back in the Kitchen, not wherever the player walked.
    expect(output.lastIndexOf('Kitchen')).toBeGreaterThan(output.lastIndexOf('Living Room'));
  });

  it('rejects a save belonging to a different story file', () => {
    const machine = new Machine(image(), {}, 1);
    const foreign = new TextEncoder().encode(
      JSON.stringify({ v: 1, release: 42, serial: '000000', pc: 0, stack: [], frames: [], rng: 1, dynamic: [] }),
    );
    expect(machine.deserialize(foreign)).toBe(false);
  });

  it('echoes back an unknown word, which needs correct parse-buffer offsets', () => {
    // The game reads the word out of the text buffer using the position the
    // tokeniser recorded. If that position is an absolute address it overflows
    // a byte and the echo comes back as control characters.
    const transcript = play(['zzzqqq']);
    expect(transcript).toContain('"zzzqqq"');
  });

  it('truncates input to six Z-characters, matching the dictionary', () => {
    // "frobozzle" encodes to the same six characters as FROBOZZ, so the game
    // answers as though the player typed the word it knows. That is not a bug
    // in the tokeniser — it is how a v3 dictionary behaves, and the original
    // is full of jokes that rely on it.
    const transcript = play(['frobozzle']);
    expect(transcript).toContain('FROBOZZ');
  });

  it('parses a comma as its own word so one line can hold two commands', () => {
    const transcript = play(['open mailbox', 'take leaflet, read it']);
    expect(transcript).toContain('WELCOME TO ZORK');
  });
});
