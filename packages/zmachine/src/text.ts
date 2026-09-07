/**
 * Z-machine text: the packed string format and its inverse.
 *
 * Infocom shipped Zork I in 84 kilobytes, and the reason it fits is this
 * encoding. Text is stored as a stream of 5-bit "Z-characters" packed three to
 * a 16-bit word, with the top bit of the word set on the final word of a
 * string. Five bits addresses 32 values, which is not enough for a character
 * set, so the encoding layers two tricks on top:
 *
 *   - Three alphabets. A0 is lowercase, A1 uppercase, A2 digits and
 *     punctuation. Z-characters 4 and 5 shift the *next* character into A1 or
 *     A2 respectively. (In v1-2 these were locking shifts. In v3 they are not,
 *     which is the single most common source of garbled output in a homemade
 *     interpreter.)
 *   - Abbreviations. Z-characters 1, 2 and 3 consume the following character
 *     to form an index into a table of 96 canned strings. Zork I uses these
 *     for the words it repeats most.
 *
 * Decoding is therefore not a table lookup but a small state machine, and it
 * has to be re-entrant because an abbreviation expands into another packed
 * string. Abbreviations may not themselves contain abbreviations, which is the
 * only reason the recursion is guaranteed to terminate.
 */

import type { Memory } from './memory.js';

/** Z-characters 6..31 in each alphabet. Index 0 of each row is Z-character 6. */
const ALPHABET_A0 = 'abcdefghijklmnopqrstuvwxyz';
const ALPHABET_A1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/**
 * A2 position 0 (Z-character 6) is not a character at all: it introduces a
 * ten-bit literal ZSCII code built from the next two Z-characters. Position 1
 * (Z-character 7) is a newline. The placeholders below keep the indexing
 * honest; both are special-cased before the table is consulted.
 */
const ALPHABET_A2 = ' \n0123456789.,!?_#\'"/\\-:()';

const ZC_SPACE = 0;
const ZC_ABBREV_FIRST = 1;
const ZC_ABBREV_LAST = 3;
const ZC_SHIFT_A1 = 4;
const ZC_SHIFT_A2 = 5;
const ZC_A2_ESCAPE = 6;
const ZC_ALPHABET_BASE = 6;

/** How many Z-characters a dictionary entry holds in v3. */
export const DICT_ZCHARS_V3 = 6;

/**
 * Unpack a run of Z-characters starting at a byte address.
 *
 * Returns the characters together with the address just past the string, which
 * the object table needs in order to find the properties that follow an
 * object's short name.
 */
export function readZChars(
  memory: Memory,
  addr: number,
): { chars: number[]; endAddr: number } {
  const chars: number[] = [];
  let cursor = addr;

  for (;;) {
    const word = memory.getWord(cursor);
    cursor += 2;

    chars.push((word >> 10) & 0x1f);
    chars.push((word >> 5) & 0x1f);
    chars.push(word & 0x1f);

    // The top bit marks the last word of the string, not the last character.
    if ((word & 0x8000) !== 0) break;
  }

  return { chars, endAddr: cursor };
}

/**
 * Turn a ZSCII code into the character it prints as.
 *
 * The interesting cases are 13, which is a newline rather than a carriage
 * return, and 0, which prints as nothing at all. Codes 155-251 select from an
 * accented-character table that Zork I never uses; they become a visible
 * placeholder rather than being silently dropped, so that a wrong decode shows
 * up instead of hiding.
 */
export function zsciiToChar(code: number): string {
  if (code === 0) return '';
  if (code === 13) return '\n';
  if (code === 9) return '\t';
  if (code === 11) return ' ';
  if (code >= 32 && code <= 126) return String.fromCharCode(code);
  return '?';
}

/**
 * Decode a packed string into text.
 *
 * `allowAbbreviations` exists because the standard forbids an abbreviation
 * from expanding to another abbreviation. Passing false while expanding one
 * turns a malformed story file into visible garbage rather than a hang.
 */
export function decodeString(
  memory: Memory,
  addr: number,
  allowAbbreviations = true,
): { text: string; endAddr: number } {
  const { chars, endAddr } = readZChars(memory, addr);
  return { text: decodeZChars(memory, chars, allowAbbreviations), endAddr };
}

export function decodeZChars(
  memory: Memory,
  chars: number[],
  allowAbbreviations = true,
): string {
  let out = '';
  // In v3 a shift affects exactly one character, so this resets every glyph.
  let alphabet = 0;
  let i = 0;

  while (i < chars.length) {
    const zc = chars[i] ?? 0;
    i += 1;

    if (zc === ZC_SPACE) {
      out += ' ';
      alphabet = 0;
      continue;
    }

    if (zc >= ZC_ABBREV_FIRST && zc <= ZC_ABBREV_LAST) {
      const next = chars[i];
      i += 1;
      if (next === undefined) break;

      if (allowAbbreviations) {
        const index = 32 * (zc - 1) + next;
        const entryAddr = memory.abbreviationsAddr + index * 2;
        // The table stores word addresses, so this is a packed address that is
        // always doubled regardless of version.
        const stringAddr = memory.getWord(entryAddr) * 2;
        out += decodeString(memory, stringAddr, false).text;
      }
      alphabet = 0;
      continue;
    }

    if (zc === ZC_SHIFT_A1) {
      alphabet = 1;
      continue;
    }

    if (zc === ZC_SHIFT_A2) {
      alphabet = 2;
      continue;
    }

    if (alphabet === 2 && zc === ZC_A2_ESCAPE) {
      // A literal ZSCII code, ten bits split across the next two characters.
      const hi = chars[i] ?? 0;
      const lo = chars[i + 1] ?? 0;
      i += 2;
      out += zsciiToChar((hi << 5) | lo);
      alphabet = 0;
      continue;
    }

    const table =
      alphabet === 0 ? ALPHABET_A0 : alphabet === 1 ? ALPHABET_A1 : ALPHABET_A2;
    out += table.charAt(zc - ZC_ALPHABET_BASE);
    alphabet = 0;
  }

  return out;
}

/**
 * Encode a word the player typed into the Z-character form the dictionary
 * stores, so that a lookup becomes a plain integer comparison.
 *
 * The result is always exactly `count` Z-characters, truncated if the word is
 * longer and padded with 5s if shorter. Padding with 5 rather than 0 matters:
 * 5 is the shift-to-A2 character, which Infocom's own encoder used as filler,
 * and a dictionary built with 5s will not match a probe built with 0s.
 *
 * Truncation is why Zork I cannot tell "disassemble" from "disassembly" — in
 * v3 only the first six Z-characters survive, and that behaviour is part of
 * the game rather than a bug to fix.
 */
export function encodeWord(word: string, count = DICT_ZCHARS_V3): number[] {
  const zchars: number[] = [];

  for (const ch of word.toLowerCase()) {
    if (zchars.length >= count) break;

    const a0 = ALPHABET_A0.indexOf(ch);
    if (a0 >= 0) {
      zchars.push(a0 + ZC_ALPHABET_BASE);
      continue;
    }

    const a2 = ALPHABET_A2.indexOf(ch);
    // Position 0 is the escape marker and position 1 is newline; neither is a
    // literal character, so only positions 2 and up are a real A2 match.
    if (a2 >= 2) {
      zchars.push(ZC_SHIFT_A2);
      zchars.push(a2 + ZC_ALPHABET_BASE);
      continue;
    }

    // Anything else goes in as a ten-bit literal: shift to A2, escape, then
    // the code split into two five-bit halves.
    const code = ch.charCodeAt(0) & 0x3ff;
    zchars.push(ZC_SHIFT_A2, ZC_A2_ESCAPE, (code >> 5) & 0x1f, code & 0x1f);
  }

  while (zchars.length < count) zchars.push(ZC_SHIFT_A2);
  return zchars.slice(0, count);
}

/** Pack encoded Z-characters into the big-endian words a dictionary holds. */
export function packZChars(zchars: number[]): number[] {
  const words: number[] = [];

  for (let i = 0; i < zchars.length; i += 3) {
    const a = zchars[i] ?? ZC_SHIFT_A2;
    const b = zchars[i + 1] ?? ZC_SHIFT_A2;
    const c = zchars[i + 2] ?? ZC_SHIFT_A2;
    words.push((a << 10) | (b << 5) | c);
  }

  if (words.length > 0) {
    // The terminator bit belongs on the final word only.
    words[words.length - 1] = (words[words.length - 1] ?? 0) | 0x8000;
  }
  return words;
}

export { ALPHABET_A0, ALPHABET_A1, ALPHABET_A2 };
