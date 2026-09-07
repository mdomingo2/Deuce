/**
 * Wiring.
 *
 * The turn loop is the heart of it and it is deliberately small: give the
 * parser a line, let the interpreter run until it asks for the next one,
 * print whatever it said, then read the world and redraw. Every input path —
 * walking through a doorway, clicking a lantern, clicking the compass, typing
 * a sentence — converges on `submit()`, so there is exactly one way for the
 * game state to change and it is always the same way the original changed it.
 *
 * The story file is Infocom's property and is not shipped here. It is looked
 * for at a well-known path first, so a local copy dropped into `public/` just
 * works, and otherwise the player supplies one and it never leaves the browser.
 */

import { Machine, WorldReader, ZORK1_R88 } from '@deuce/zmachine';
import type { Direction, WorldSnapshot } from '@deuce/zmachine';

import { WorldView } from './scene/view.js';
import { Hud } from './ui/hud.js';
import { GameConsole } from './ui/console.js';

const STORY_URL = '/zork1.z3';
const SAVE_KEY = 'zork1:save';

// ------------------------------------------------------------------- loading

const loaderCard = document.querySelector<HTMLElement>('.loader-card');
const loaderPanel = document.getElementById('loader');
const loaderMessage = document.getElementById('loader-message');
const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
const fileDrop = document.getElementById('file-drop');

function setLoaderMessage(text: string, isError = false): void {
  if (loaderMessage) loaderMessage.textContent = text;
  loaderCard?.classList.toggle('is-error', isError);
}

/**
 * Find a story file.
 *
 * A fetch that 404s is the expected path, not an error: it just means nobody
 * has put a copy in `public/` and the player will choose one.
 */
async function locateStory(): Promise<Uint8Array> {
  try {
    const response = await fetch(STORY_URL);
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Guard against a dev server that answers 200 with an HTML error page.
      if (bytes.length > 64 && bytes[0] === 3) return bytes;
    }
  } catch {
    // Fall through to asking the player.
  }

  setLoaderMessage('No story file found. Choose your copy of Zork I to begin.');

  return new Promise((resolve) => {
    const accept = async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length < 64) {
        setLoaderMessage(`${file.name} is too small to be a story file.`, true);
        return;
      }
      if (bytes[0] !== 3) {
        setLoaderMessage(
          `${file.name} is a version ${bytes[0]} story file. Zork I is version 3.`,
          true,
        );
        return;
      }
      resolve(bytes);
    };

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void accept(file);
    });

    // Dropping the file anywhere on the panel works too.
    for (const type of ['dragenter', 'dragover'] as const) {
      loaderPanel?.addEventListener(type, (event) => {
        event.preventDefault();
        fileDrop?.classList.add('is-dragging');
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      loaderPanel?.addEventListener(type, () => fileDrop?.classList.remove('is-dragging'));
    }
    loaderPanel?.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void accept(file);
    });
  });
}

// ---------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  const image = await locateStory();

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud');
  const hint = document.getElementById('hint');

  // Atmosphere layers, inserted here rather than in the markup so that the
  // document stays readable as a description of the interface.
  const effects = document.createElement('div');
  effects.className = 'overlay-effects';
  document.body.append(effects);

  const fade = document.createElement('div');
  fade.className = 'room-fade';
  document.body.append(fade);

  /** Text the story produced during the current turn. */
  let pending = '';

  const machine = new Machine(image, {
    onOutput: (text) => {
      pending += text;
    },
    onSave: (data) => {
      try {
        // Base64 rather than raw bytes, because localStorage holds strings.
        localStorage.setItem(SAVE_KEY, btoa(String.fromCharCode(...data)));
        return true;
      } catch {
        return false;
      }
    },
    onRestore: () => {
      const stored = localStorage.getItem(SAVE_KEY);
      if (!stored) return undefined;
      try {
        return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      } catch {
        return undefined;
      }
    },
  });

  const reader = new WorldReader(machine, ZORK1_R88);

  let lastRoom = -1;
  let travellingVia: Direction | null = null;
  let busy = false;

  const gameConsole = new GameConsole((command) => submit(command, null));
  const hud = new Hud((direction) => submit(direction, direction));

  const view = new WorldView(canvas, {
    onMove: (direction) => submit(direction, direction),
    onInteract: (_number, name) => {
      // Turn a click into the most useful sentence for that object. The game
      // still decides what happens; this only picks the verb.
      const noun = name.replace(/^(a|an|the)\s+/i, '');
      submit(`take ${noun}`, null);
    },
    onFocus: (label) => hud.setFocus(label),
  });

  /**
   * Advance the game by one command and redraw.
   *
   * `direction` is passed separately from the command text because the view
   * needs to know which way the player travelled in order to stand them at the
   * correct side of the next room — and it must only do that when the game
   * agrees a move happened.
   */
  function submit(command: string, direction: Direction | null): void {
    if (busy || machine.isHalted) return;
    busy = true;
    view.setMovementLocked(true);

    if (!gameConsole.hasFocus) gameConsole.echo(command);

    pending = '';
    machine.provideInput(command);
    const result = machine.run();

    gameConsole.print(pending);
    travellingVia = direction;
    render(result.kind === 'quit');

    busy = false;
    view.setMovementLocked(false);
  }

  function render(halted: boolean): void {
    const snapshot: WorldSnapshot = reader.snapshot();
    hud.update(snapshot);

    const changedRoom = snapshot.room.number !== lastRoom;
    if (changedRoom) {
      // A brief blackout covers the rebuild and reads as walking through a
      // doorway rather than as a scene pop.
      fade.classList.add('is-active');
      view.setRoom(snapshot, lastRoom === -1 ? null : travellingVia);
      lastRoom = snapshot.room.number;
      requestAnimationFrame(() => fade.classList.remove('is-active'));
    } else {
      view.refreshRoom(snapshot);
    }

    if (halted) {
      gameConsole.print('\n[The story has ended. Reload to begin again.]');
    }
  }

  // Run to the opening prompt before showing anything.
  pending = '';
  machine.run();
  gameConsole.print(pending);
  render(false);

  loaderPanel?.setAttribute('hidden', '');
  hudRoot?.removeAttribute('hidden');
  view.start();

  // ------------------------------------------------------------- input focus

  view.onLockChange((locked) => {
    gameConsole.setIdle(locked);
    if (locked) hint?.classList.add('is-hidden');
    else hint?.classList.remove('is-hidden');
  });

  canvas.addEventListener('click', () => {
    if (!view.isLocked) view.lock();
  });

  // Movement keys and typed commands share a keyboard, and without pointer
  // lock there is nothing else to tell "w" meaning walk from "w" being typed
  // into the prompt.
  const promptInput = document.getElementById('prompt-input');
  promptInput?.addEventListener('focus', () => view.setTyping(true));
  promptInput?.addEventListener('blur', () => view.setTyping(false));

  window.addEventListener('keydown', (event) => {
    // Tab drops out of mouse-look and into the prompt, and back again.
    if (event.code === 'Tab') {
      event.preventDefault();
      if (gameConsole.hasFocus) {
        view.lock();
      } else {
        view.unlock();
        gameConsole.focus();
      }
    }
  });
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  setLoaderMessage(message, true);
  // Rethrowing here would only produce an unhandled rejection; the player has
  // already been told what went wrong.
  console.error(error);
});
