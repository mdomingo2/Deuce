/**
 * The dictionary and the tokeniser.
 *
 * Zork I's parser does not work on strings. Before any verb logic runs, the
 * line the player typed is chopped into words, each word is encoded into the
 * same six Z-character form the dictionary stores, and the result is looked up
 * by binary search. What the game actually sees is a list of dictionary
 * addresses — so a word the dictionary has never heard of arrives as address
 * zero, and that is how "I don't know the word 'xyzzy'" is produced. (Zork I
 * does know xyzzy. It is simply not impressed.)
 *
 * v3 layout:
 *
 *   [0]        n, the number of word separators
 *   [1..n]     the separator characters themselves, as ZSCII
 *   [n+1]      bytes per entry (at least 4 in v3)
 *   [n+2..n+3] number of entries; negative means the table is unsorted
 *   [n+4..]    the entries, each 4 bytes of packed text then game data
 *
 * Two details in here are load-bearing for authenticity. Separators are words
 * in their own right, which is what makes a comma split "take lamp, go north"
 * into two commands. And encoding truncates at six Z-characters, so the game
 * genuinely cannot distinguish longer words that share a prefix; that is
 * period behaviour, not something to correct.
 */

import type { Memory } from './memory.js';
import { DICT_ZCHARS_V3, encodeWord, packZChars } from './text.js';

/** A word the tokeniser found in the player's input. */
export interface Token {
  /** The text as typed, lowercased. */
  text: string;
  /** Dictionary entry address, or 0 if the word is not in the dictionary. */
  dictAddr: number;
  /** Offset of the word within the text buffer, as the parse buffer wants it. */
  position: number;
  length: number;
}

export class Dictionary {
  readonly separators: string[];
  readonly entryLength: number;
  readonly entryCount: number;
  readonly entriesAddr: number;
  /**
   * Whether the entries are in ascending order. Infocom's own dictionaries
   * always are, which allows a binary search, but the standard permits an
   * unsorted table flagged by a negative count and a game can build one at
   * runtime.
   */
  readonly sorted: boolean;

  constructor(private readonly memory: Memory) {
    const base = memory.dictionaryAddr;
    const separatorCount = memory.getByte(base);

    this.separators = [];
    for (let i = 0; i < separatorCount; i += 1) {
      this.separators.push(String.fromCharCode(memory.getByte(base + 1 + i)));
    }

    const lengthAddr = base + 1 + separatorCount;
    this.entryLength = memory.getByte(lengthAddr);

    const rawCount = memory.getWord(lengthAddr + 1);
    const signedCount = rawCount >= 0x8000 ? rawCount - 0x10000 : rawCount;
    this.sorted = signedCount >= 0;
    this.entryCount = Math.abs(signedCount);

    this.entriesAddr = lengthAddr + 3;
  }

  private entryAddr(index: number): number {
    return this.entriesAddr + index * this.entryLength;
  }

  /**
   * Compare a probe's packed words against the entry at `index`.
   *
   * v3 entries are two words. Comparing them as a pair of unsigned integers
   * gives exactly the ordering Infocom's encoder produced, so a binary search
   * over this comparison is correct.
   */
  private compareEntry(index: number, probe: number[]): number {
    const addr = this.entryAddr(index);
    for (let w = 0; w < probe.length; w += 1) {
      const entryWord = this.memory.getWord(addr + w * 2);
      const probeWord = probe[w] ?? 0;
      if (probeWord !== entryWord) return probeWord < entryWord ? -1 : 1;
    }
    return 0;
  }

  /** Find a word's dictionary address, or 0 if it is not there. */
  lookup(word: string): number {
    const probe = packZChars(encodeWord(word, DICT_ZCHARS_V3));

    if (this.sorted) {
      let lo = 0;
      let hi = this.entryCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cmp = this.compareEntry(mid, probe);
        if (cmp === 0) return this.entryAddr(mid);
        if (cmp < 0) hi = mid - 1;
        else lo = mid + 1;
      }
      return 0;
    }

    for (let i = 0; i < this.entryCount; i += 1) {
      if (this.compareEntry(i, probe) === 0) return this.entryAddr(i);
    }
    return 0;
  }

  /**
   * Split a line into dictionary tokens.
   *
   * `textStart` is the *offset within the text buffer* at which the line
   * begins — 1 in v3, where byte 0 holds the buffer's maximum length. The
   * parse buffer records each word's position as such an offset, in a single
   * byte, and the game reads the word back out of the text buffer from there
   * when it needs to say "I don't know the word ...". Passing an absolute
   * address instead overflows that byte and the game echoes garbage.
   */
  tokenise(line: string, textStart: number): Token[] {
    const tokens: Token[] = [];
    const text = line.toLowerCase();

    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);

      if (ch === ' ' || ch === '\t') {
        i += 1;
        continue;
      }

      // A separator is a complete word on its own, never part of the one
      // beside it. This is what turns "take lamp, then go north" into
      // something the game can read as two commands.
      if (this.separators.includes(ch)) {
        tokens.push({
          text: ch,
          dictAddr: this.lookup(ch),
          position: textStart + i,
          length: 1,
        });
        i += 1;
        continue;
      }

      let end = i;
      while (
        end < text.length &&
        text.charAt(end) !== ' ' &&
        text.charAt(end) !== '\t' &&
        !this.separators.includes(text.charAt(end))
      ) {
        end += 1;
      }

      const word = text.slice(i, end);
      tokens.push({
        text: word,
        dictAddr: this.lookup(word),
        position: textStart + i,
        length: word.length,
      });
      i = end;
    }

    return tokens;
  }
}
