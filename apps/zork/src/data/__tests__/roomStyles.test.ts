/**
 * Room styling tests.
 *
 * The art direction is the one part of this project that is invention rather
 * than transcription, so what is worth testing is not whether a room looks
 * good — that is a judgement — but whether the classifier reaches a sensible
 * answer for *every* room in the game rather than only the ones that were
 * hand-authored. The room names below are the real ones, read out of the story
 * file's object table.
 */

import { describe, expect, it } from 'vitest';
import { classifyRoom, styleFor } from '../roomStyles.js';

/**
 * Every room in Zork I release 88, with whether it lights itself.
 *
 * Extracted by walking the object table for objects carrying at least one
 * direction property. Duplicated names are real: there are four Forests, five
 * stretches of the Frigid River and eleven Maze rooms.
 */
const ROOMS: [name: string, selfLit: boolean][] = [
  ['Canyon View', true], ['Rocky Ledge', true], ['Canyon Bottom', true],
  ['On the Rainbow', true], ['Aragain Falls', true], ['Shore', true],
  ['Frigid River', true], ['Clearing', true], ['Forest Path', true],
  ['Forest', true], ['Behind House', true], ['South of House', true],
  ['North of House', true], ['Up a Tree', true], ['End of Rainbow', true],
  ['Dam Base', true], ['Gallery', true], ['Mirror Room', true],
  ['Dam Lobby', true], ['Stone Barrow', true], ['West of House', true],
  ['Living Room', true], ['Kitchen', true], ['Altar', true], ['Dam', true],
  ['Temple', true], ['Land of the Dead', true], ['Entrance to Hades', true],
  ['Slide Room', false], ['Coal Mine', false], ['Ladder Bottom', false],
  ['Ladder Top', false], ['Smelly Room', false], ['Squeaky Room', false],
  ['Mine Entrance', false], ['White Cliffs Beach', false], ['Chasm', false],
  ['North-South Passage', false], ['Damp Cave', false], ['Deep Canyon', false],
  ['East-West Passage', false], ['Twisting Passage', false],
  ['Winding Passage', false], ['Narrow Passage', false], ['Cold Passage', false],
  ['Cave', false], ['Stream', false], ['Stream View', false],
  ['Reservoir South', false], ['Strange Passage', false], ['Maze', false],
  ['Dead End', false], ['Grating Room', false], ['East of Chasm', false],
  ['Cellar', false], ['Studio', false], ['Engravings Cave', false],
  ['Reservoir', false], ['The Troll Room', false], ['Torch Room', false],
  ['Round Room', false], ['Sandy Beach', false], ['Gas Room', false],
  ['Sandy Cave', false], ['Dome Room', false], ['Loud Room', false],
  ['Machine Room', false], ['Reservoir North', false], ['Egyptian Room', false],
  ['Cyclops Room', false], ['Atlantis Room', false], ['Treasure Room', false],
  ['Maintenance Room', false], ['Attic', false], ['Timber Room', false],
  ['Bat Room', false], ['Shaft Room', false], ['Drafty Room', false],
];

describe('room classification', () => {
  it('puts the landmark rooms in the family a player would expect', () => {
    expect(classifyRoom('West of House', true)).toBe('house-exterior');
    expect(classifyRoom('Kitchen', true)).toBe('house-interior');
    expect(classifyRoom('Cellar', false)).toBe('cellar');
    expect(classifyRoom('Maze', false)).toBe('maze');
    expect(classifyRoom('Dead End', false)).toBe('maze');
    expect(classifyRoom('Temple', true)).toBe('temple');
    expect(classifyRoom('Coal Mine', false)).toBe('mine');
    // The same name is a riverbank in daylight and a flooded cavern in the dark.
    expect(classifyRoom('Frigid River', true)).toBe('riverbank');
    expect(classifyRoom('Frigid River', false)).toBe('water');
    expect(classifyRoom('Entrance to Hades', true)).toBe('hades');
    expect(classifyRoom('Treasure Room', false)).toBe('vault');
  });

  it('reads a bare "Passage" name as a corridor', () => {
    for (const name of ['Twisting Passage', 'Cold Passage', 'Narrow Passage']) {
      expect(classifyRoom(name, false)).toBe('passage');
    }
  });

  it('orders its patterns so the more specific one wins', () => {
    // "Dam Base" contains "Dam" but is a waterside room; "Mirror Room" contains
    // "Room" but is a vault. Both depend on pattern order.
    expect(classifyRoom('Dam Base', true)).toBe('dam');
    expect(classifyRoom('Mirror Room', true)).toBe('vault');
    expect(classifyRoom('Deep Canyon', false)).toBe('cave');
  });

  it('never leaves a room in the game without a usable style', () => {
    for (const [name, selfLit] of ROOMS) {
      const style = styleFor(1, name, selfLit);

      expect(style.width, `${name} width`).toBeGreaterThan(2);
      expect(style.depth, `${name} depth`).toBeGreaterThan(2);
      // Anything under two metres is shorter than the player.
      expect(style.height, `${name} height`).toBeGreaterThan(2);
      expect(style.floorTint, `${name} floor tint`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.wallTint, `${name} wall tint`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.fogColor, `${name} fog colour`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.fogDensity, `${name} fog density`).toBeGreaterThan(0);
    }
  });

  it('gives every dark room somewhere for the lantern to matter', () => {
    // A room the game says is dark must not be styled as if it were outdoors,
    // or the player would arrive in a lit field the story calls pitch black.
    for (const [name, selfLit] of ROOMS) {
      if (selfLit) continue;
      const style = styleFor(1, name, selfLit);
      expect(style.ceiling, `${name} should be enclosed`).not.toBeNull();
      expect(style.ambient, `${name} ambient`).toBeLessThan(0.35);
    }
  });

  it('opens every self-lit outdoor room to the sky', () => {
    for (const name of ['West of House', 'Forest', 'Clearing', 'Canyon View']) {
      expect(styleFor(1, name, true).ceiling).toBeNull();
    }
  });

  it('keeps the maze rooms identical to each other', () => {
    // The maze's design is that one room is indistinguishable from the next.
    // Giving them distinct looks would quietly solve the puzzle.
    const a = styleFor(52, 'Maze', false);
    const b = styleFor(59, 'Maze', false);
    const c = styleFor(64, 'Maze', false);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('varies the forests, which are meant to be different places', () => {
    // Four rooms print "Forest" but they are distinct locations, so their
    // per-object seeds must differ or every one grows the same trees.
    const seeds = [76, 77, 78, 239].map((n) => styleFor(n, 'Forest', true).seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('lets a by-name override beat the family it belongs to', () => {
    const family = styleFor(1, 'Cave', false);
    const dome = styleFor(1, 'Dome Room', false);
    expect(dome.height).toBeGreaterThan(family.height);
  });
});
