/**
 * Z-machine memory model.
 *
 * A story file is a single flat address space that the interpreter both
 * executes and mutates in place. It is divided into three regions by two
 * addresses in the header:
 *
 *   dynamic   [0, staticBase)        readable and writable; this is the part
 *                                    that a save file has to capture
 *   static    [staticBase, highBase) readable only
 *   high      [highBase, end)        routines and strings; reachable only via
 *                                    packed addresses, never read as data
 *
 * Every multi-byte value is big-endian. That is worth stating loudly because
 * the temptation is to index the underlying `Uint8Array` directly and shift
 * bytes by hand, which is both slower and easy to get backwards. Going through
 * a `DataView` gets big-endian for free and, under `noUncheckedIndexedAccess`,
 * keeps the return type a plain `number` instead of `number | undefined` —
 * an interpreter does hundreds of thousands of these reads per turn and cannot
 * afford a null check on each one.
 */

/**
 * Byte offsets of the header fields this interpreter reads.
 *
 * The header is the first 64 bytes of every story file and its layout is
 * fixed by the Z-Machine Standards Document. Only the v3 fields appear here;
 * later versions add fields in the gaps.
 */
export const Header = {
  VERSION: 0x00,
  FLAGS1: 0x01,
  RELEASE: 0x02,
  HIGH_BASE: 0x04,
  INITIAL_PC: 0x06,
  DICTIONARY: 0x08,
  OBJECT_TABLE: 0x0a,
  GLOBALS: 0x0c,
  STATIC_BASE: 0x0e,
  FLAGS2: 0x10,
  SERIAL: 0x12,
  ABBREVIATIONS: 0x18,
  FILE_LENGTH: 0x1a,
  CHECKSUM: 0x1c,
  INTERPRETER_NUMBER: 0x1e,
  INTERPRETER_VERSION: 0x1f,
  SCREEN_HEIGHT: 0x20,
  SCREEN_WIDTH: 0x21,
} as const;

/** Bits in the FLAGS1 header byte that a v3 interpreter is expected to set. */
export const Flags1 = {
  /** Set by the interpreter if it cannot display a status line. */
  NO_STATUS_LINE: 0x10,
  /** Set by the interpreter if a split screen is available. */
  SCREEN_SPLIT: 0x20,
  /** Set by the interpreter if a variable-pitch font is the default. */
  VARIABLE_FONT_DEFAULT: 0x40,
  /** Set by the *game* if the status line reports time rather than score. */
  STATUS_IS_TIME: 0x02,
} as const;

/** Header size in bytes. Nothing below this address belongs to the game. */
export const HEADER_SIZE = 64;

export class Memory {
  /**
   * The live story image. Exposed so that save/restore can snapshot the
   * dynamic region without copying through an accessor a byte at a time.
   */
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  /** A pristine copy of the original image, kept for `restart` and undo. */
  private readonly original: Uint8Array;

  readonly version: number;
  readonly staticBase: number;
  readonly highBase: number;
  readonly dictionaryAddr: number;
  readonly objectTableAddr: number;
  readonly globalsAddr: number;
  readonly abbreviationsAddr: number;
  readonly initialPC: number;
  readonly release: number;
  readonly serial: string;
  readonly declaredChecksum: number;
  /**
   * Length of the story file as declared in the header. Stored divided by 2
   * in v3, which is why it needs a scale factor rather than being read as-is.
   */
  readonly declaredLength: number;

  constructor(image: Uint8Array) {
    if (image.length < HEADER_SIZE) {
      throw new Error(
        `Story file is ${image.length} bytes; a Z-machine header alone is ${HEADER_SIZE}.`,
      );
    }

    this.bytes = new Uint8Array(image);
    this.original = new Uint8Array(image);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );

    this.version = this.view.getUint8(Header.VERSION);
    if (this.version !== 3) {
      throw new Error(
        `This interpreter implements Z-machine version 3 only; story file declares version ${this.version}.`,
      );
    }

    this.release = this.view.getUint16(Header.RELEASE);
    this.highBase = this.view.getUint16(Header.HIGH_BASE);
    this.initialPC = this.view.getUint16(Header.INITIAL_PC);
    this.dictionaryAddr = this.view.getUint16(Header.DICTIONARY);
    this.objectTableAddr = this.view.getUint16(Header.OBJECT_TABLE);
    this.globalsAddr = this.view.getUint16(Header.GLOBALS);
    this.staticBase = this.view.getUint16(Header.STATIC_BASE);
    this.abbreviationsAddr = this.view.getUint16(Header.ABBREVIATIONS);
    this.declaredChecksum = this.view.getUint16(Header.CHECKSUM);
    // v3 packs the length into a word by halving it, capping story files at 128K.
    this.declaredLength = this.view.getUint16(Header.FILE_LENGTH) * 2;

    let serial = '';
    for (let i = 0; i < 6; i += 1) {
      serial += String.fromCharCode(this.view.getUint8(Header.SERIAL + i));
    }
    this.serial = serial;
  }

  getByte(addr: number): number {
    return this.view.getUint8(addr);
  }

  getWord(addr: number): number {
    return this.view.getUint16(addr);
  }

  setByte(addr: number, value: number): void {
    if (addr >= this.staticBase) {
      throw new Error(
        `Write of byte to 0x${addr.toString(16)} is inside static memory (starts at 0x${this.staticBase.toString(16)}).`,
      );
    }
    this.view.setUint8(addr, value & 0xff);
  }

  setWord(addr: number, value: number): void {
    if (addr >= this.staticBase) {
      throw new Error(
        `Write of word to 0x${addr.toString(16)} is inside static memory (starts at 0x${this.staticBase.toString(16)}).`,
      );
    }
    this.view.setUint16(addr, value & 0xffff);
  }

  /**
   * Header writes bypass the static-memory guard.
   *
   * The header sits at address 0, well inside dynamic memory, but a few of its
   * bytes are the interpreter's to set rather than the game's — screen size,
   * interpreter number, capability flags. Those are written once at startup
   * before the game is allowed to run.
   */
  setHeaderByte(addr: number, value: number): void {
    if (addr >= HEADER_SIZE) {
      throw new Error(`0x${addr.toString(16)} is not a header address.`);
    }
    this.view.setUint8(addr, value & 0xff);
  }

  /**
   * Expand a packed address into a byte address.
   *
   * Routines and strings live in high memory, above the 64K a 16-bit address
   * can reach, so they are referred to by an address divided by a version
   * dependent scale factor — 2 in v3. This is also why routines and strings
   * must begin at even addresses.
   */
  unpack(packed: number): number {
    return packed * 2;
  }

  /** Read a global variable. Globals are a flat array of 240 words. */
  getGlobal(index: number): number {
    return this.view.getUint16(this.globalsAddr + index * 2);
  }

  setGlobal(index: number, value: number): void {
    this.view.setUint16(this.globalsAddr + index * 2, value & 0xffff);
  }

  /** A copy of the dynamic region, which is all that save files need to hold. */
  snapshotDynamic(): Uint8Array {
    return this.bytes.slice(0, this.staticBase);
  }

  restoreDynamic(snapshot: Uint8Array): void {
    if (snapshot.length !== this.staticBase) {
      throw new Error(
        `Snapshot is ${snapshot.length} bytes but dynamic memory is ${this.staticBase}.`,
      );
    }
    this.bytes.set(snapshot, 0);
  }

  /** Reset the image to the file as loaded, for `restart`. */
  reset(): void {
    this.bytes.set(this.original, 0);
  }

  /**
   * Verify the story file against its own checksum, the sum of every byte
   * after the header modulo 0x10000. `verify` in the game exposes this, and
   * Zork I's own "verify" verb reports it to the player.
   */
  verifyChecksum(): boolean {
    const end = Math.min(this.declaredLength, this.bytes.length);
    let sum = 0;
    for (let addr = HEADER_SIZE; addr < end; addr += 1) {
      sum += this.view.getUint8(addr);
    }
    return (sum & 0xffff) === this.declaredChecksum;
  }
}

/** Reinterpret an unsigned 16-bit word as the signed value the Z-machine sees. */
export function toSigned(value: number): number {
  const v = value & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Truncate a signed result back into the unsigned 16-bit storage form. */
export function toUnsigned(value: number): number {
  return value & 0xffff;
}
