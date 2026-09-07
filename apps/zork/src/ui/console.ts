/**
 * The text console.
 *
 * The 3D view can express where you are and what is lying around. It cannot
 * express "The troll's mighty blow drops you to your knees", and it should not
 * try — Infocom's prose is the game. So the transcript stays, and so does a
 * full command line: anything the original understood can still be typed, and
 * clicking or walking is a shortcut rather than a replacement.
 *
 * Keeping the parser reachable is also what makes the visual layer honest
 * about its own gaps. If a puzzle needs "tie rope to railing", the renderer
 * has no gesture for that, and inventing one would mean inventing a rule. The
 * prompt is always there instead.
 */

const HISTORY_LIMIT = 100;

export class GameConsole {
  private readonly transcript: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly root: HTMLElement;

  private readonly history: string[] = [];
  private historyIndex = -1;

  constructor(private readonly onCommand: (command: string) => void) {
    this.root = this.require('console');
    this.transcript = this.require('transcript');
    this.form = this.require<HTMLFormElement>('prompt-form');
    this.input = this.require<HTMLInputElement>('prompt-input');

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const command = this.input.value.trim();
      if (command === '') return;

      this.input.value = '';
      this.remember(command);
      this.echo(command);
      this.onCommand(command);
    });

    this.input.addEventListener('keydown', (event) => {
      // Up and down walk the command history, as a terminal would.
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.recall(1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.recall(-1);
      } else if (event.key === 'Escape') {
        this.input.blur();
      }
    });
  }

  private require<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`The console is missing #${id}.`);
    return found as T;
  }

  private remember(command: string): void {
    this.history.unshift(command);
    if (this.history.length > HISTORY_LIMIT) this.history.pop();
    this.historyIndex = -1;
  }

  private recall(step: number): void {
    const next = this.historyIndex + step;
    if (next < -1 || next >= this.history.length) return;
    this.historyIndex = next;
    this.input.value = next === -1 ? '' : (this.history[next] ?? '');
    // Put the caret at the end, not at the start, which is where setting
    // `value` would otherwise leave it.
    requestAnimationFrame(() => {
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    });
  }

  /** Show a command as the player's own, the way a terminal echoes it. */
  echo(command: string): void {
    const line = document.createElement('p');
    line.className = 'echo';
    line.textContent = `>${command}`;
    this.transcript.append(line);
    this.scrollToEnd();
  }

  /**
   * Append story output.
   *
   * The interpreter emits text in fragments with its own line breaks, so this
   * splits on blank lines into paragraphs and leaves everything else exactly
   * as Infocom wrote it — including the spacing inside the leaflet.
   */
  print(text: string): void {
    const trimmed = text.replace(/^\n+/, '').replace(/\n+$/, '');
    if (trimmed === '') return;

    for (const paragraph of trimmed.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      this.transcript.append(p);
    }
    this.scrollToEnd();
  }

  private scrollToEnd(): void {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  focus(): void {
    this.input.focus();
  }

  get hasFocus(): boolean {
    return document.activeElement === this.input;
  }

  /** Dim the transcript while the player is looking around. */
  setIdle(idle: boolean): void {
    this.root.classList.toggle('is-idle', idle);
  }
}
