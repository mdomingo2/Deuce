/**
 * The Z-machine version 3 interpreter.
 *
 * This is the part that makes the whole project honest. Every room
 * description, every puzzle, the thief's wandering and thieving, the troll's
 * combat table, the grue, the 100-unit carry limit — none of it is written
 * anywhere in this repository. It is all in the story file, and this executes
 * the story file. The visual layer downstream can only ever show what the
 * original code decided; it has no way to invent a room or soften a rule.
 *
 * The design constraint that shapes everything here is that a browser cannot
 * block. A traditional interpreter's read-a-line opcode simply stops the
 * world and waits on stdin. Instead, `run()` executes until the story asks for
 * input, then returns, leaving the machine parked with its program counter
 * already past the read instruction. The host renders a frame, collects a
 * command whenever it likes, calls `provideInput()` to fill in the buffers the
 * read was going to fill, and calls `run()` again. The VM never knows it was
 * suspended, and the game cannot tell the difference.
 */

import { Memory, toSigned, toUnsigned, Header, Flags1 } from './memory.js';
import { ObjectTable } from './objects.js';
import { Dictionary } from './dictionary.js';
import { decodeString, zsciiToChar } from './text.js';

/** Why `run()` came back. */
export type RunResult =
  | { kind: 'input'; textBuffer: number; parseBuffer: number }
  | { kind: 'quit' }
  | { kind: 'budget-exhausted' };

/** One activation record. v3's only call opcode always stores a result. */
interface Frame {
  returnPC: number;
  locals: number[];
  /** Height of the evaluation stack when this frame was pushed. */
  stackBase: number;
  /** Variable the return value goes into. */
  storeVariable: number;
  argumentCount: number;
}

export interface StatusLine {
  /** Object number of the room the status line names. */
  roomObject: number;
  roomName: string;
  score: number;
  turns: number;
  /** v3 story files may report a clock instead of a score. */
  isTimeGame: boolean;
  hours: number;
  minutes: number;
}

export interface MachineHooks {
  /** Called whenever the story prints. Text arrives in fragments, not lines. */
  onOutput?: (text: string) => void;
  /** Called when the story refreshes the status line. */
  onStatus?: (status: StatusLine) => void;
  /** Persist a save. Return false to report failure to the story. */
  onSave?: (data: Uint8Array) => boolean;
  /** Produce a previously saved state, or undefined if there is none. */
  onRestore?: () => Uint8Array | undefined;
}

const OPERAND_LARGE = 0;
const OPERAND_SMALL = 1;
const OPERAND_VARIABLE = 2;
const OPERAND_OMITTED = 3;

/**
 * Ceiling on instructions executed in a single `run()`.
 *
 * A story file that loops forever would otherwise lock the browser tab with no
 * way back. This is deliberately far above any real turn — Zork I's most
 * expensive turns run in the low tens of thousands of instructions — so
 * hitting it means something is genuinely wrong.
 */
const DEFAULT_INSTRUCTION_BUDGET = 5_000_000;

export class Machine {
  readonly memory: Memory;
  readonly objects: ObjectTable;
  readonly dictionary: Dictionary;

  private pc = 0;
  private stack: number[] = [];
  private frames: Frame[] = [];
  private hooks: MachineHooks;

  private halted = false;
  /** Set while parked at a read instruction, holding the buffers to fill. */
  private pendingRead: { textBuffer: number; parseBuffer: number } | null = null;

  /**
   * Output stream state. Stream 1 is the screen. Stream 3 redirects into a
   * table in story memory and, while active, suppresses the screen entirely —
   * a v3 game uses it to measure text before printing it.
   */
  private screenEnabled = true;
  private redirectStack: number[] = [];

  private rngState: number;

  constructor(image: Uint8Array, hooks: MachineHooks = {}, seed?: number) {
    this.memory = new Memory(image);
    this.objects = new ObjectTable(this.memory);
    this.dictionary = new Dictionary(this.memory);
    this.hooks = hooks;
    this.rngState = (seed ?? Date.now()) >>> 0 || 1;

    this.reset();
  }

  /** Point the machine at the story's entry point and declare our capabilities. */
  private reset(): void {
    this.pc = this.memory.initialPC;
    this.stack = [];
    this.frames = [];
    this.halted = false;
    this.pendingRead = null;
    this.screenEnabled = true;
    this.redirectStack = [];

    // The story reads these to decide what it may do. Claiming a status line
    // and a splittable screen is what a modern host actually provides.
    const flags1 = this.memory.getByte(Header.FLAGS1);
    this.memory.setHeaderByte(
      Header.FLAGS1,
      (flags1 & ~Flags1.NO_STATUS_LINE & ~Flags1.VARIABLE_FONT_DEFAULT) |
        Flags1.SCREEN_SPLIT,
    );
    // Interpreter number 6 is "IBM PC", the least surprising answer for a v3
    // story file, and version 'A' is the conventional first revision.
    this.memory.setHeaderByte(Header.INTERPRETER_NUMBER, 6);
    this.memory.setHeaderByte(Header.INTERPRETER_VERSION, 'A'.charCodeAt(0));
    this.memory.setHeaderByte(Header.SCREEN_HEIGHT, 25);
    this.memory.setHeaderByte(Header.SCREEN_WIDTH, 80);
  }

  restart(): void {
    this.memory.reset();
    this.reset();
  }

  get isHalted(): boolean {
    return this.halted;
  }

  get isAwaitingInput(): boolean {
    return this.pendingRead !== null;
  }

  // ----------------------------------------------------------------- output

  private emit(text: string): void {
    if (text === '') return;

    // A redirect to a table swallows the text instead of showing it, and it
    // nests: only the innermost table receives.
    const table = this.redirectStack[this.redirectStack.length - 1];
    if (table !== undefined) {
      const used = this.memory.getWord(table);
      let cursor = table + 2 + used;
      for (const ch of text) {
        this.memory.setByte(cursor, ch.charCodeAt(0) & 0xff);
        cursor += 1;
      }
      this.memory.setWord(table, used + text.length);
      return;
    }

    if (this.screenEnabled) this.hooks.onOutput?.(text);
  }

  // -------------------------------------------------------------- variables

  private readVariable(variable: number, indirect = false): number {
    if (variable === 0) {
      // An indirect reference reads the top of the stack without popping it.
      // Getting this wrong corrupts the stack in ways that surface much later.
      if (indirect) return this.stack[this.stack.length - 1] ?? 0;
      const value = this.stack.pop();
      if (value === undefined) throw new Error('Pop from an empty stack.');
      return value;
    }

    if (variable < 16) {
      const frame = this.frames[this.frames.length - 1];
      if (!frame) throw new Error(`Local variable ${variable} read outside any routine.`);
      return frame.locals[variable - 1] ?? 0;
    }

    return this.memory.getGlobal(variable - 16);
  }

  private writeVariable(variable: number, value: number, indirect = false): void {
    const v = toUnsigned(value);

    if (variable === 0) {
      if (indirect) {
        if (this.stack.length === 0) this.stack.push(v);
        else this.stack[this.stack.length - 1] = v;
        return;
      }
      this.stack.push(v);
      return;
    }

    if (variable < 16) {
      const frame = this.frames[this.frames.length - 1];
      if (!frame) throw new Error(`Local variable ${variable} written outside any routine.`);
      frame.locals[variable - 1] = v;
      return;
    }

    this.memory.setGlobal(variable - 16, v);
  }

  // ------------------------------------------------------- instruction read

  private nextByte(): number {
    const value = this.memory.getByte(this.pc);
    this.pc += 1;
    return value;
  }

  private nextWord(): number {
    const value = this.memory.getWord(this.pc);
    this.pc += 2;
    return value;
  }

  private readOperand(type: number): number {
    switch (type) {
      case OPERAND_LARGE:
        return this.nextWord();
      case OPERAND_SMALL:
        return this.nextByte();
      case OPERAND_VARIABLE:
        return this.readVariable(this.nextByte());
      default:
        throw new Error(`Cannot read an omitted operand.`);
    }
  }

  /** Read the type byte of a variable-form instruction and fetch its operands. */
  private readVariableOperands(): number[] {
    const typeByte = this.nextByte();
    const operands: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      const type = (typeByte >> (6 - i * 2)) & 3;
      if (type === OPERAND_OMITTED) break;
      operands.push(this.readOperand(type));
    }

    return operands;
  }

  // ------------------------------------------------------------- call/return

  private callRoutine(
    packedAddr: number,
    args: number[],
    storeVariable: number,
  ): void {
    // Calling address 0 is legal and simply yields false, which story files
    // use as a cheap conditional call.
    if (packedAddr === 0) {
      this.writeVariable(storeVariable, 0);
      return;
    }

    const routineAddr = this.memory.unpack(packedAddr);
    const localCount = this.memory.getByte(routineAddr);
    if (localCount > 15) {
      throw new Error(
        `Routine at 0x${routineAddr.toString(16)} declares ${localCount} locals; the maximum is 15.`,
      );
    }

    const locals: number[] = [];
    let cursor = routineAddr + 1;
    // v3 stores an initial value for each local in the routine header. v5
    // dropped this and zeroes them instead.
    for (let i = 0; i < localCount; i += 1) {
      locals.push(this.memory.getWord(cursor));
      cursor += 2;
    }

    // Arguments overwrite the leading locals. Extra arguments are discarded.
    for (let i = 0; i < args.length && i < localCount; i += 1) {
      locals[i] = toUnsigned(args[i] ?? 0);
    }

    this.frames.push({
      returnPC: this.pc,
      locals,
      stackBase: this.stack.length,
      storeVariable,
      argumentCount: args.length,
    });

    // Execution begins after the header, past the locals' initial values.
    this.pc = cursor;
  }

  private returnFromRoutine(value: number): void {
    const frame = this.frames.pop();
    if (!frame) throw new Error('Return with no routine to return from.');

    // Anything the routine left on the evaluation stack is discarded, which is
    // what keeps a story file's stack discipline from leaking across calls.
    this.stack.length = frame.stackBase;
    this.pc = frame.returnPC;
    this.writeVariable(frame.storeVariable, value);
  }

  // ---------------------------------------------------------------- branches

  /**
   * Consume a branch operand and take it if `condition` matches its sense.
   *
   * Offsets 0 and 1 are not offsets at all: they mean "return false" and
   * "return true" from the current routine, which is how the compiler encodes
   * a conditional return without spending a jump.
   */
  private branch(condition: boolean): void {
    const first = this.nextByte();
    const branchOnTrue = (first & 0x80) !== 0;

    let offset: number;
    if ((first & 0x40) !== 0) {
      offset = first & 0x3f;
    } else {
      const second = this.nextByte();
      offset = ((first & 0x3f) << 8) | second;
      // A 14-bit signed quantity, so the sign bit is 0x2000.
      if ((offset & 0x2000) !== 0) offset -= 0x4000;
    }

    if (condition !== branchOnTrue) return;

    if (offset === 0) {
      this.returnFromRoutine(0);
      return;
    }
    if (offset === 1) {
      this.returnFromRoutine(1);
      return;
    }
    this.pc += offset - 2;
  }

  // -------------------------------------------------------------------- rng

  /**
   * xorshift32, seeded and reproducible.
   *
   * The story file drives the thief's wandering and every combat roll through
   * this, so a fixed seed makes a playthrough replayable — which is the only
   * practical way to write a regression test over a game this stateful.
   */
  private nextRandom(): number {
    let x = this.rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x || 1;
    return this.rngState;
  }

  private random(range: number): number {
    const signed = toSigned(range);

    if (signed > 0) return (this.nextRandom() % signed) + 1;

    // A negative argument seeds the generator; zero asks for an unpredictable
    // seed. Both return zero rather than a random number.
    this.rngState = signed === 0 ? (Date.now() >>> 0) || 1 : (-signed) >>> 0 || 1;
    return 0;
  }

  // ------------------------------------------------------------ status line

  /**
   * Build the status line from the globals the standard reserves for it.
   *
   * Global 0 is the current room, global 1 the score and global 2 the turn
   * count — except in a "time game", flagged in the header, where the last two
   * are hours and minutes instead. Zork I is a score game; this handles both
   * so the interpreter is not quietly Zork-specific.
   */
  buildStatusLine(): StatusLine {
    const roomObject = this.memory.getGlobal(0);
    const first = toSigned(this.memory.getGlobal(1));
    const second = toSigned(this.memory.getGlobal(2));
    const isTimeGame =
      (this.memory.getByte(Header.FLAGS1) & Flags1.STATUS_IS_TIME) !== 0;

    return {
      roomObject,
      roomName: roomObject === 0 ? '' : this.objects.getName(roomObject),
      score: isTimeGame ? 0 : first,
      turns: isTimeGame ? 0 : second,
      isTimeGame,
      hours: isTimeGame ? first : 0,
      minutes: isTimeGame ? second : 0,
    };
  }

  private showStatus(): void {
    this.hooks.onStatus?.(this.buildStatusLine());
  }

  // ------------------------------------------------------------------ input

  /**
   * Complete the read the machine is parked on.
   *
   * The text buffer takes the line as ZSCII, lowercased, from byte 1 and
   * zero-terminated. The parse buffer takes four bytes per word: the
   * dictionary address, the word's length, and where it sat in the text
   * buffer. Byte 0 of each buffer is a maximum set by the story and must be
   * respected — overrunning it corrupts whatever the story put next in memory.
   */
  provideInput(line: string): void {
    const pending = this.pendingRead;
    if (!pending) throw new Error('provideInput called while no read is pending.');
    this.pendingRead = null;

    const { textBuffer, parseBuffer } = pending;

    const maxChars = this.memory.getByte(textBuffer) - 1;
    const text = line.toLowerCase().slice(0, Math.max(0, maxChars));

    for (let i = 0; i < text.length; i += 1) {
      this.memory.setByte(textBuffer + 1 + i, text.charCodeAt(i) & 0xff);
    }
    this.memory.setByte(textBuffer + 1 + text.length, 0);

    // A parse buffer address of 0 means the story wants the raw text only.
    if (parseBuffer === 0) return;

    const maxWords = this.memory.getByte(parseBuffer);
    // Positions are offsets into the text buffer, and in v3 the text starts at
    // byte 1 because byte 0 carries the buffer's capacity.
    const tokens = this.dictionary.tokenise(text, 1).slice(0, maxWords);

    this.memory.setByte(parseBuffer + 1, tokens.length);
    tokens.forEach((token, index) => {
      const entry = parseBuffer + 2 + index * 4;
      this.memory.setWord(entry, token.dictAddr);
      this.memory.setByte(entry + 2, token.length);
      this.memory.setByte(entry + 3, token.position);
    });
  }

  // -------------------------------------------------------------- execution

  /**
   * Execute until the story needs a line of input, quits, or runs past the
   * instruction budget.
   */
  run(budget = DEFAULT_INSTRUCTION_BUDGET): RunResult {
    if (this.halted) return { kind: 'quit' };

    // The loop condition, rather than an early return, is what establishes
    // that a read is pending once the loop exits — which is both the clearer
    // control flow and the one the type checker can follow.
    let executed = 0;
    while (this.pendingRead === null) {
      if (executed >= budget) return { kind: 'budget-exhausted' };
      this.step();
      if (this.halted) return { kind: 'quit' };
      executed += 1;
    }

    return {
      kind: 'input',
      textBuffer: this.pendingRead.textBuffer,
      parseBuffer: this.pendingRead.parseBuffer,
    };
  }

  /** Decode and execute exactly one instruction. */
  step(): void {
    const opByte = this.nextByte();

    if (opByte < 0x80) {
      // Long form: always 2OP, operand types packed into bits 6 and 5.
      const type1 = (opByte & 0x40) !== 0 ? OPERAND_VARIABLE : OPERAND_SMALL;
      const type2 = (opByte & 0x20) !== 0 ? OPERAND_VARIABLE : OPERAND_SMALL;
      const a = this.readOperand(type1);
      const b = this.readOperand(type2);
      this.execute2OP(opByte & 0x1f, [a, b]);
      return;
    }

    if (opByte < 0xc0) {
      // Short form. Bits 5-4 give the single operand's type; type 3 (omitted)
      // means there is no operand at all and this is a 0OP instruction.
      const type = (opByte >> 4) & 3;
      if (type === OPERAND_OMITTED) {
        this.execute0OP(opByte & 0x0f);
      } else {
        this.execute1OP(opByte & 0x0f, this.readOperand(type));
      }
      return;
    }

    // Variable form. Bit 5 clear means it is a 2OP opcode given a variable
    // operand list, which is how `je` gets to compare up to four values.
    const operands = this.readVariableOperands();
    if ((opByte & 0x20) === 0) {
      this.execute2OP(opByte & 0x1f, operands);
    } else {
      this.executeVAR(opByte & 0x1f, operands);
    }
  }

  private execute2OP(opcode: number, operands: number[]): void {
    const a = operands[0] ?? 0;
    const b = operands[1] ?? 0;

    switch (opcode) {
      case 0x01: {
        // je compares its first operand against every other one. In variable
        // form it can take up to four, which is why this is not just a === b.
        const rest = operands.slice(1);
        this.branch(rest.some((value) => value === a));
        return;
      }
      case 0x02:
        this.branch(toSigned(a) < toSigned(b));
        return;
      case 0x03:
        this.branch(toSigned(a) > toSigned(b));
        return;
      case 0x04: {
        const value = toSigned(this.readVariable(a, true)) - 1;
        this.writeVariable(a, value, true);
        this.branch(value < toSigned(b));
        return;
      }
      case 0x05: {
        const value = toSigned(this.readVariable(a, true)) + 1;
        this.writeVariable(a, value, true);
        this.branch(value > toSigned(b));
        return;
      }
      case 0x06:
        this.branch(this.objects.getParent(a) === b);
        return;
      case 0x07:
        // Bitmap test: every bit set in b must be set in a.
        this.branch((a & b) === b);
        return;
      case 0x08:
        this.storeResult(a | b);
        return;
      case 0x09:
        this.storeResult(a & b);
        return;
      case 0x0a:
        this.branch(this.objects.testAttribute(a, b));
        return;
      case 0x0b:
        this.objects.setAttribute(a, b);
        return;
      case 0x0c:
        this.objects.clearAttribute(a, b);
        return;
      case 0x0d:
        this.writeVariable(a, b, true);
        return;
      case 0x0e:
        this.objects.insertObject(a, b);
        return;
      case 0x0f:
        this.storeResult(this.memory.getWord(a + 2 * toSigned(b)));
        return;
      case 0x10:
        this.storeResult(this.memory.getByte(a + toSigned(b)));
        return;
      case 0x11:
        this.storeResult(this.objects.getProperty(a, b));
        return;
      case 0x12:
        this.storeResult(this.objects.getPropertyAddress(a, b));
        return;
      case 0x13:
        this.storeResult(this.objects.getNextProperty(a, b));
        return;
      case 0x14:
        this.storeResult(toSigned(a) + toSigned(b));
        return;
      case 0x15:
        this.storeResult(toSigned(a) - toSigned(b));
        return;
      case 0x16:
        this.storeResult(toSigned(a) * toSigned(b));
        return;
      case 0x17: {
        const divisor = toSigned(b);
        if (divisor === 0) throw new Error('Division by zero.');
        // Z-machine division truncates toward zero, which is not what a
        // floored division would give for negative operands.
        this.storeResult(Math.trunc(toSigned(a) / divisor));
        return;
      }
      case 0x18: {
        const divisor = toSigned(b);
        if (divisor === 0) throw new Error('Remainder by zero.');
        const result = Math.abs(toSigned(a)) % Math.abs(divisor);
        this.storeResult(toSigned(a) < 0 ? -result : result);
        return;
      }
      default:
        throw new Error(`Unimplemented 2OP opcode 0x${opcode.toString(16)}.`);
    }
  }

  private execute1OP(opcode: number, operand: number): void {
    switch (opcode) {
      case 0x00:
        this.branch(operand === 0);
        return;
      case 0x01: {
        const sibling = this.objects.getSibling(operand);
        this.storeResult(sibling);
        this.branch(sibling !== 0);
        return;
      }
      case 0x02: {
        const child = this.objects.getChild(operand);
        this.storeResult(child);
        this.branch(child !== 0);
        return;
      }
      case 0x03:
        this.storeResult(this.objects.getParent(operand));
        return;
      case 0x04:
        this.storeResult(this.objects.getPropertyLength(operand));
        return;
      case 0x05:
        this.writeVariable(operand, toSigned(this.readVariable(operand, true)) + 1, true);
        return;
      case 0x06:
        this.writeVariable(operand, toSigned(this.readVariable(operand, true)) - 1, true);
        return;
      case 0x07:
        this.emit(decodeString(this.memory, operand).text);
        return;
      case 0x09:
        this.objects.removeObject(operand);
        return;
      case 0x0a:
        this.emit(this.objects.getName(operand));
        return;
      case 0x0b:
        this.returnFromRoutine(operand);
        return;
      case 0x0c:
        // jump takes a signed offset directly rather than a branch operand.
        this.pc += toSigned(operand) - 2;
        return;
      case 0x0d:
        this.emit(decodeString(this.memory, this.memory.unpack(operand)).text);
        return;
      case 0x0e:
        this.storeResult(this.readVariable(operand, true));
        return;
      case 0x0f:
        this.storeResult(~operand & 0xffff);
        return;
      default:
        throw new Error(`Unimplemented 1OP opcode 0x${opcode.toString(16)}.`);
    }
  }

  private execute0OP(opcode: number): void {
    switch (opcode) {
      case 0x00:
        this.returnFromRoutine(1);
        return;
      case 0x01:
        this.returnFromRoutine(0);
        return;
      case 0x02: {
        // The string is inline, immediately after the opcode, so decoding it
        // is also how we find the next instruction.
        const { text, endAddr } = decodeString(this.memory, this.pc);
        this.emit(text);
        this.pc = endAddr;
        return;
      }
      case 0x03: {
        const { text } = decodeString(this.memory, this.pc);
        this.emit(text);
        this.emit('\n');
        this.returnFromRoutine(1);
        return;
      }
      case 0x04:
        return;
      case 0x05:
        this.doSave();
        return;
      case 0x06:
        this.doRestore();
        return;
      case 0x07:
        this.restart();
        return;
      case 0x08: {
        const value = this.stack.pop();
        if (value === undefined) throw new Error('ret_popped with an empty stack.');
        this.returnFromRoutine(value);
        return;
      }
      case 0x09:
        this.stack.pop();
        return;
      case 0x0a:
        this.halted = true;
        return;
      case 0x0b:
        this.emit('\n');
        return;
      case 0x0c:
        this.showStatus();
        return;
      case 0x0d:
        this.branch(this.memory.verifyChecksum());
        return;
      default:
        throw new Error(`Unimplemented 0OP opcode 0x${opcode.toString(16)}.`);
    }
  }

  private executeVAR(opcode: number, operands: number[]): void {
    switch (opcode) {
      case 0x00: {
        const [routine, ...args] = operands;
        const storeVariable = this.nextByte();
        this.callRoutine(routine ?? 0, args, storeVariable);
        return;
      }
      case 0x01:
        this.memory.setWord(
          (operands[0] ?? 0) + 2 * toSigned(operands[1] ?? 0),
          operands[2] ?? 0,
        );
        return;
      case 0x02:
        this.memory.setByte(
          (operands[0] ?? 0) + toSigned(operands[1] ?? 0),
          operands[2] ?? 0,
        );
        return;
      case 0x03:
        this.objects.putProperty(operands[0] ?? 0, operands[1] ?? 0, operands[2] ?? 0);
        return;
      case 0x04: {
        // sread. The standard requires the status line to be refreshed before
        // the player is asked for anything, so this is where a v3 game's
        // score and room name actually update on screen.
        this.showStatus();
        this.pendingRead = {
          textBuffer: operands[0] ?? 0,
          parseBuffer: operands[1] ?? 0,
        };
        return;
      }
      case 0x05:
        // Via the ZSCII table rather than String.fromCharCode: code 13 is a
        // newline and code 0 prints nothing at all, neither of which a raw
        // character conversion gets right.
        this.emit(zsciiToChar(operands[0] ?? 0));
        return;
      case 0x06:
        this.emit(String(toSigned(operands[0] ?? 0)));
        return;
      case 0x07:
        this.storeResult(this.random(operands[0] ?? 0));
        return;
      case 0x08:
        this.stack.push(toUnsigned(operands[0] ?? 0));
        return;
      case 0x09: {
        const value = this.stack.pop();
        if (value === undefined) throw new Error('pull from an empty stack.');
        this.writeVariable(operands[0] ?? 0, value, true);
        return;
      }
      case 0x0a:
      case 0x0b:
        // split_window and set_window. The visual host has no text windows to
        // split; the status line it draws comes from buildStatusLine instead.
        return;
      case 0x13: {
        const stream = toSigned(operands[0] ?? 0);
        if (stream === 1) this.screenEnabled = true;
        else if (stream === -1) this.screenEnabled = false;
        else if (stream === 3) {
          const table = operands[1] ?? 0;
          this.memory.setWord(table, 0);
          this.redirectStack.push(table);
        } else if (stream === -3) this.redirectStack.pop();
        return;
      }
      case 0x14:
      case 0x15:
        // input_stream and sound_effect. Zork I r88 emits no sound; a
        // no-op here is the correct response rather than an error.
        return;
      default:
        throw new Error(`Unimplemented VAR opcode 0x${opcode.toString(16)}.`);
    }
  }

  /** Consume the store byte that follows a storing instruction. */
  private storeResult(value: number): void {
    this.writeVariable(this.nextByte(), value);
  }

  // ------------------------------------------------------------ save/restore

  /**
   * Serialise everything a resumed game needs: dynamic memory, the evaluation
   * stack, the call frames, and the program counter.
   *
   * This is not Quetzal. Quetzal's value is portability between interpreters,
   * which costs an XOR-compressed memory chunk and a stack-frame encoding that
   * buys nothing when the only reader is this same interpreter in the same
   * browser. The format is versioned so that a stored save can be rejected
   * cleanly rather than resumed into nonsense.
   */
  serialize(): Uint8Array {
    const state = {
      v: 1,
      release: this.memory.release,
      serial: this.memory.serial,
      pc: this.pc,
      stack: this.stack,
      frames: this.frames,
      rng: this.rngState,
      dynamic: Array.from(this.memory.snapshotDynamic()),
    };
    return new TextEncoder().encode(JSON.stringify(state));
  }

  deserialize(data: Uint8Array): boolean {
    try {
      const state = JSON.parse(new TextDecoder().decode(data)) as {
        v: number;
        release: number;
        serial: string;
        pc: number;
        stack: number[];
        frames: Frame[];
        rng: number;
        dynamic: number[];
      };

      // A save from a different release of the story file would restore into
      // memory that means something else entirely.
      if (state.v !== 1) return false;
      if (state.release !== this.memory.release || state.serial !== this.memory.serial) {
        return false;
      }

      this.memory.restoreDynamic(Uint8Array.from(state.dynamic));
      this.pc = state.pc;
      this.stack = state.stack;
      this.frames = state.frames;
      this.rngState = state.rng;
      this.halted = false;
      this.pendingRead = null;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * v3 `save` is a branch instruction, and the branch is taken on success.
   *
   * The subtlety is that the saved program counter points at this very branch
   * operand. On a later restore, execution resumes here and takes the branch
   * again — so the story's "Ok." after saving and its "Ok." after restoring
   * come from the same line of Infocom's code. Preserving that is why restore
   * does not need its own branch handling.
   */
  private doSave(): void {
    if (!this.hooks.onSave) {
      this.branch(false);
      return;
    }
    const succeeded = this.hooks.onSave(this.serialize());
    this.branch(succeeded);
  }

  private doRestore(): void {
    const data = this.hooks.onRestore?.();
    if (!data) {
      this.branch(false);
      return;
    }
    if (!this.deserialize(data)) {
      this.branch(false);
      return;
    }
    // The restored PC sits on the original save's branch operand; taking it as
    // true reproduces the save-point behaviour exactly.
    this.branch(true);
  }
}
