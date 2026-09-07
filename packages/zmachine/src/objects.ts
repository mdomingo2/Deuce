/**
 * The object table.
 *
 * Every noun in Zork I — rooms, the brass lantern, the thief, the player
 * themselves — is an entry in one flat table, and the world's shape is a tree
 * expressed through three byte-sized links per object: parent, sibling, child.
 * "The lamp is in the living room" and "the player is in the living room" are
 * the same fact stored the same way, which is why picking something up is just
 * a re-parent.
 *
 * This module is doing double duty. The interpreter needs it to execute
 * `get_parent`, `insert_obj` and friends. The visual layer needs it for
 * something the original never had a use for: reading the live tree between
 * turns to find out which room the player is standing in and what is on the
 * floor next to them. Both go through the same accessors, so the renderer can
 * never see a world that disagrees with the one the game is running.
 *
 * v3 layout:
 *
 *   objectTableAddr + 0    31 words of property defaults (properties 1..31)
 *   objectTableAddr + 62   object 1, then object 2, ... 9 bytes each:
 *                            [0..3] 32 attribute bits, bit 0 is the MSB of [0]
 *                            [4]    parent object number
 *                            [5]    sibling object number
 *                            [6]    child object number
 *                            [7..8] address of the property table
 *
 * Object 0 is not an object. It is the null link, and reading its fields is a
 * bug in the story file rather than something to support.
 */

import type { Memory } from './memory.js';
import { decodeString } from './text.js';

/** v3 stores 31 property defaults; property numbers run 1..31. */
const PROPERTY_DEFAULTS_COUNT = 31;
const OBJECT_ENTRY_SIZE = 9;
const OBJECT_TREE_OFFSET = PROPERTY_DEFAULTS_COUNT * 2;

/** v3 addresses objects with a single byte, so 255 is the hard ceiling. */
export const MAX_OBJECTS_V3 = 255;

export interface PropertyEntry {
  number: number;
  /** Address of the property's data, which is what `get_prop_addr` returns. */
  dataAddr: number;
  /** Data length in bytes: 1, 2, or up to 8 for a table-valued property. */
  length: number;
}

export class ObjectTable {
  constructor(private readonly memory: Memory) {}

  private entryAddr(obj: number): number {
    if (obj < 1 || obj > MAX_OBJECTS_V3) {
      throw new Error(`Object ${obj} is out of range for a version 3 story file.`);
    }
    return (
      this.memory.objectTableAddr +
      OBJECT_TREE_OFFSET +
      (obj - 1) * OBJECT_ENTRY_SIZE
    );
  }

  /**
   * Attributes are numbered from the most significant bit of the first byte,
   * so attribute 0 is 0x80 of byte 0 and attribute 31 is 0x01 of byte 3. Every
   * off-by-one in this function shows up as a puzzle that cannot be solved.
   */
  private attributeLocation(attr: number): { byteOffset: number; mask: number } {
    if (attr < 0 || attr > 31) {
      throw new Error(`Attribute ${attr} is out of range; v3 objects have 32.`);
    }
    return { byteOffset: attr >> 3, mask: 0x80 >> (attr & 7) };
  }

  testAttribute(obj: number, attr: number): boolean {
    if (obj === 0) return false;
    const { byteOffset, mask } = this.attributeLocation(attr);
    return (this.memory.getByte(this.entryAddr(obj) + byteOffset) & mask) !== 0;
  }

  setAttribute(obj: number, attr: number): void {
    if (obj === 0) return;
    const { byteOffset, mask } = this.attributeLocation(attr);
    const addr = this.entryAddr(obj) + byteOffset;
    this.memory.setByte(addr, this.memory.getByte(addr) | mask);
  }

  clearAttribute(obj: number, attr: number): void {
    if (obj === 0) return;
    const { byteOffset, mask } = this.attributeLocation(attr);
    const addr = this.entryAddr(obj) + byteOffset;
    this.memory.setByte(addr, this.memory.getByte(addr) & ~mask & 0xff);
  }

  getParent(obj: number): number {
    return obj === 0 ? 0 : this.memory.getByte(this.entryAddr(obj) + 4);
  }

  getSibling(obj: number): number {
    return obj === 0 ? 0 : this.memory.getByte(this.entryAddr(obj) + 5);
  }

  getChild(obj: number): number {
    return obj === 0 ? 0 : this.memory.getByte(this.entryAddr(obj) + 6);
  }

  private setParent(obj: number, value: number): void {
    this.memory.setByte(this.entryAddr(obj) + 4, value);
  }

  private setSibling(obj: number, value: number): void {
    this.memory.setByte(this.entryAddr(obj) + 5, value);
  }

  private setChild(obj: number, value: number): void {
    this.memory.setByte(this.entryAddr(obj) + 6, value);
  }

  /**
   * Detach an object from whatever contains it.
   *
   * The sibling list is singly linked, so removing a child that is not the
   * first one means walking the list to find its predecessor. Getting this
   * wrong tends to produce a world where an object is simultaneously in two
   * rooms, or a sibling chain that loops forever.
   */
  removeObject(obj: number): void {
    if (obj === 0) return;
    const parent = this.getParent(obj);
    if (parent === 0) return;

    const firstChild = this.getChild(parent);
    if (firstChild === obj) {
      this.setChild(parent, this.getSibling(obj));
    } else {
      let cursor = firstChild;
      while (cursor !== 0 && this.getSibling(cursor) !== obj) {
        cursor = this.getSibling(cursor);
      }
      if (cursor !== 0) {
        this.setSibling(cursor, this.getSibling(obj));
      }
    }

    this.setParent(obj, 0);
    this.setSibling(obj, 0);
  }

  /** Move `obj` into `destination`, at the front of its child list. */
  insertObject(obj: number, destination: number): void {
    if (obj === 0) return;
    this.removeObject(obj);
    if (destination === 0) return;

    this.setSibling(obj, this.getChild(destination));
    this.setChild(destination, obj);
    this.setParent(obj, destination);
  }

  /** Every direct child of an object, in sibling order. */
  getChildren(obj: number): number[] {
    const children: number[] = [];
    let cursor = this.getChild(obj);
    // A corrupt sibling chain would otherwise spin forever; the table cannot
    // hold more than 255 objects, so exceeding that means the links are bad.
    let guard = 0;
    while (cursor !== 0 && guard < MAX_OBJECTS_V3) {
      children.push(cursor);
      cursor = this.getSibling(cursor);
      guard += 1;
    }
    return children;
  }

  private propertyTableAddr(obj: number): number {
    return this.memory.getWord(this.entryAddr(obj) + 7);
  }

  /**
   * An object's printed name, stored as a packed string at the head of its
   * property table with a leading byte giving its length in words.
   */
  getName(obj: number): string {
    if (obj === 0) return '';
    const tableAddr = this.propertyTableAddr(obj);
    const nameWords = this.memory.getByte(tableAddr);
    if (nameWords === 0) return '';
    return decodeString(this.memory, tableAddr + 1).text;
  }

  /**
   * Walk an object's property list.
   *
   * Properties are stored in descending numeric order, which is what lets
   * `get_next_prop` work and what lets a lookup stop early once it passes the
   * number it wants. In v3 the size byte packs both fields: the low five bits
   * are the property number and the top three are the length minus one, so a
   * property can hold at most eight bytes.
   */
  listProperties(obj: number): PropertyEntry[] {
    if (obj === 0) return [];
    const tableAddr = this.propertyTableAddr(obj);
    const nameWords = this.memory.getByte(tableAddr);

    const entries: PropertyEntry[] = [];
    let cursor = tableAddr + 1 + nameWords * 2;

    for (;;) {
      const sizeByte = this.memory.getByte(cursor);
      if (sizeByte === 0) break;

      const number = sizeByte & 0x1f;
      const length = (sizeByte >> 5) + 1;
      entries.push({ number, dataAddr: cursor + 1, length });
      cursor += 1 + length;
    }

    return entries;
  }

  findProperty(obj: number, property: number): PropertyEntry | undefined {
    return this.listProperties(obj).find((entry) => entry.number === property);
  }

  /** The default value used when an object does not carry a property itself. */
  getPropertyDefault(property: number): number {
    return this.memory.getWord(
      this.memory.objectTableAddr + (property - 1) * 2,
    );
  }

  /**
   * Read a property, falling back to the table default.
   *
   * Only one- and two-byte properties can be read this way. The standard calls
   * a longer one unspecified rather than an error, and Infocom's interpreters
   * returned the first word, so that is what happens here — a story file that
   * relies on it should keep working.
   */
  getProperty(obj: number, property: number): number {
    const entry = obj === 0 ? undefined : this.findProperty(obj, property);
    if (!entry) return this.getPropertyDefault(property);
    return entry.length === 1
      ? this.memory.getByte(entry.dataAddr)
      : this.memory.getWord(entry.dataAddr);
  }

  putProperty(obj: number, property: number, value: number): void {
    const entry = this.findProperty(obj, property);
    if (!entry) {
      throw new Error(
        `put_prop on property ${property} of object ${obj}, which does not have it.`,
      );
    }
    if (entry.length === 1) {
      this.memory.setByte(entry.dataAddr, value & 0xff);
    } else {
      this.memory.setWord(entry.dataAddr, value & 0xffff);
    }
  }

  getPropertyAddress(obj: number, property: number): number {
    return this.findProperty(obj, property)?.dataAddr ?? 0;
  }

  /**
   * Length of the property whose *data* begins at `dataAddr`.
   *
   * The size byte sits immediately before the data, which is the whole reason
   * this can be answered from an address alone with no object number in hand.
   * Address 0 answers 0, a special case the standard added in 1.1 for code
   * that chains `get_prop_addr` straight into `get_prop_len`.
   */
  getPropertyLength(dataAddr: number): number {
    if (dataAddr === 0) return 0;
    return (this.memory.getByte(dataAddr - 1) >> 5) + 1;
  }

  /** The property after `property` in descending order; 0 asks for the first. */
  getNextProperty(obj: number, property: number): number {
    const entries = this.listProperties(obj);
    if (property === 0) return entries[0]?.number ?? 0;

    const index = entries.findIndex((entry) => entry.number === property);
    if (index < 0) {
      throw new Error(
        `get_next_prop asked for the property after ${property} on object ${obj}, which does not have it.`,
      );
    }
    return entries[index + 1]?.number ?? 0;
  }

  /**
   * How many objects the table holds.
   *
   * The count is not stored anywhere. The convention every interpreter relies
   * on is that the first object's property table begins immediately after the
   * last object entry, so the gap between the tree's start and that address,
   * divided by the entry size, is the object count.
   */
  countObjects(): number {
    const treeStart = this.memory.objectTableAddr + OBJECT_TREE_OFFSET;
    const firstPropAddr = this.memory.getWord(treeStart + 7);
    return Math.min(
      Math.floor((firstPropAddr - treeStart) / OBJECT_ENTRY_SIZE),
      MAX_OBJECTS_V3,
    );
  }
}
