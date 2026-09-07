/**
 * The heads-up display.
 *
 * Every panel here answers a question that the text game answered with a
 * command. The inventory list is "i", the score and move counters are the v3
 * status line, and the compass is the part of a room description that lists
 * the ways out. None of them is new information — they are the same facts,
 * shown continuously instead of on request, because in a first-person view
 * stopping to type "i" every few moves breaks the thing entirely.
 *
 * The carry bar is the one that earns its place. Zork I's load limit is a
 * constant irritation by design, and in the original you only discover you are
 * over it when something refuses to be picked up. Showing the number does not
 * change the rule — the story file still enforces it — but it turns a mystery
 * into a decision.
 */

import type { Direction, Exit, ObjectView, WorldSnapshot } from '@deuce/zmachine';

/** Compass layout: the 3x3 rose, then the four that have no bearing. */
const ROSE: (Direction | null)[] = [
  'northwest',
  'north',
  'northeast',
  'west',
  null,
  'east',
  'southwest',
  'south',
  'southeast',
];
const VERTICAL: Direction[] = ['up', 'down', 'in', 'out'];

const ABBREVIATION: Record<Direction, string> = {
  north: 'N',
  south: 'S',
  east: 'E',
  west: 'W',
  northeast: 'NE',
  northwest: 'NW',
  southeast: 'SE',
  southwest: 'SW',
  up: 'UP',
  down: 'DN',
  in: 'IN',
  out: 'OUT',
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The HUD is missing #${id}.`);
  return found as T;
}

/** Whether the game will currently let the player through. */
function passable(exit: Exit): boolean {
  switch (exit.kind) {
    case 'plain':
    case 'computed':
      return true;
    case 'blocked':
      return false;
    case 'conditional':
    case 'door':
      return exit.passable;
  }
}

function describeExit(exit: Exit): string {
  switch (exit.kind) {
    case 'plain':
      return exit.toName;
    case 'blocked':
      return exit.message.replace(/\s+/g, ' ').trim();
    case 'conditional':
      return exit.passable ? exit.toName : 'Not that way, yet';
    case 'door':
      return exit.passable ? exit.toName : `${exit.doorName} is closed`;
    case 'computed':
      return 'That way';
  }
}

export class Hud {
  private readonly roomName = element('room-name');
  private readonly score = element('score');
  private readonly moves = element('moves');
  private readonly carryFill = element('carry-fill');
  private readonly carryText = element('carry-text');
  private readonly inventory = element<HTMLUListElement>('inventory');
  private readonly compass = element('compass');
  private readonly reticle = element('reticle');
  private readonly focusLabel = element('focus-label');

  private readonly verticalRow = document.createElement('div');

  constructor(private readonly onDirection: (direction: Direction) => void) {
    this.buildCompass();
  }

  private buildCompass(): void {
    for (const direction of ROSE) {
      const cell = document.createElement('div');
      cell.className = 'compass-cell';
      if (direction) {
        cell.dataset['direction'] = direction;
        cell.textContent = ABBREVIATION[direction];
      } else {
        // The centre of the rose is the player; it never lights up.
        cell.textContent = '·';
      }
      this.compass.append(cell);
    }

    this.verticalRow.className = 'compass-vertical';
    for (const direction of VERTICAL) {
      const cell = document.createElement('div');
      cell.className = 'compass-cell';
      cell.dataset['direction'] = direction;
      cell.textContent = ABBREVIATION[direction];
      this.verticalRow.append(cell);
    }
    this.compass.parentElement?.append(this.verticalRow);

    const handler = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const direction = target.dataset['direction'];
      // Only directions the room actually offers are clickable; a dead cell
      // must not send a command the room has no answer for.
      if (!direction || !target.classList.contains('is-open')) {
        if (!direction || !target.classList.contains('is-shut')) return;
      }
      this.onDirection(direction as Direction);
    };
    this.compass.addEventListener('click', handler);
    this.verticalRow.addEventListener('click', handler);
  }

  /** Render an inventory entry and anything visible inside it. */
  private renderItem(item: ObjectView, depth: number, into: HTMLUListElement): void {
    const li = document.createElement('li');
    li.textContent = depth > 0 ? `${'· '.repeat(depth)}${item.name}` : item.name;
    if (depth > 0) li.classList.add('is-nested');
    if (item.providesLight) li.classList.add('is-lit');
    into.append(li);

    for (const child of item.contents) this.renderItem(child, depth + 1, into);
  }

  update(snapshot: WorldSnapshot): void {
    this.roomName.textContent = snapshot.lit ? snapshot.room.name : 'Darkness';
    this.score.textContent = String(snapshot.score);
    this.moves.textContent = String(snapshot.moves);

    // Carry weight.
    const { bulk, limit } = snapshot.carried;
    const ratio = limit > 0 ? Math.min(1, bulk / limit) : 0;
    this.carryFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.carryFill.classList.toggle('is-heavy', ratio >= 0.7 && ratio < 0.9);
    this.carryFill.classList.toggle('is-full', ratio >= 0.9);
    this.carryText.textContent = `${bulk} / ${limit}`;

    // Inventory.
    this.inventory.replaceChildren();
    if (snapshot.inventory.length === 0) {
      const li = document.createElement('li');
      li.className = 'inventory-empty';
      li.textContent = 'empty-handed';
      this.inventory.append(li);
    } else {
      for (const item of snapshot.inventory) this.renderItem(item, 0, this.inventory);
    }

    // Compass. In the dark the exits are not knowable, so the rose goes blank
    // rather than quietly handing the player a map they should not have.
    const byDirection = new Map<Direction, Exit>();
    if (snapshot.lit) {
      for (const exit of snapshot.exits) byDirection.set(exit.direction, exit);
    }

    const cells = [
      ...this.compass.querySelectorAll<HTMLElement>('.compass-cell'),
      ...this.verticalRow.querySelectorAll<HTMLElement>('.compass-cell'),
    ];
    for (const cell of cells) {
      const direction = cell.dataset['direction'] as Direction | undefined;
      cell.classList.remove('is-open', 'is-shut');
      cell.removeAttribute('title');
      if (!direction) continue;

      const exit = byDirection.get(direction);
      if (!exit) continue;

      cell.classList.add(passable(exit) ? 'is-open' : 'is-shut');
      cell.title = describeExit(exit);
    }
  }

  setFocus(label: string | null): void {
    this.reticle.classList.toggle('is-targeting', label !== null);
    this.focusLabel.classList.toggle('is-visible', label !== null);
    if (label) this.focusLabel.textContent = label;
  }
}
