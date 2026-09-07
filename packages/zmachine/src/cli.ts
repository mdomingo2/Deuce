/**
 * A terminal driver for the interpreter.
 *
 * This exists to prove the VM independently of any graphics. If Zork I is not
 * completable from this command line then nothing built on top of it can be
 * trusted, so it is also the harness used to record the transcripts the tests
 * replay.
 *
 *   pnpm --filter @deuce/zmachine play -- stories/zork1-r88-s840726.z3
 *   pnpm --filter @deuce/zmachine play -- stories/zork1.z3 --script moves.txt
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Machine } from './machine.js';

interface Options {
  storyPath: string;
  scriptPath?: string;
  seed?: number;
  /** Print the status line before each prompt, as a real v3 terminal would. */
  showStatus: boolean;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let scriptPath: string | undefined;
  let seed: number | undefined;
  let showStatus = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--script') {
      scriptPath = argv[i + 1];
      i += 1;
    } else if (arg === '--seed') {
      seed = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--no-status') {
      showStatus = false;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const storyPath = positional[0];
  if (storyPath === undefined) {
    throw new Error(
      'Usage: play <story.z3> [--script moves.txt] [--seed N] [--no-status]',
    );
  }

  return {
    storyPath,
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...(seed !== undefined ? { seed } : {}),
    showStatus,
  };
}

const options = parseArgs(process.argv.slice(2));
const image = new Uint8Array(readFileSync(options.storyPath));

const SAVE_PATH = `${options.storyPath}.qzl`;
let pendingStatus = '';

const machine = new Machine(
  image,
  {
    onOutput: (text) => process.stdout.write(text),
    onStatus: (status) => {
      pendingStatus = status.isTimeGame
        ? `${status.roomName}  ${String(status.hours).padStart(2, '0')}:${String(status.minutes).padStart(2, '0')}`
        : `${status.roomName}  Score: ${status.score}  Moves: ${status.turns}`;
    },
    onSave: (data) => {
      writeFileSync(SAVE_PATH, data);
      return true;
    },
    onRestore: () =>
      existsSync(SAVE_PATH) ? new Uint8Array(readFileSync(SAVE_PATH)) : undefined,
  },
  options.seed,
);

console.error(
  `[story: release ${machine.memory.release}, serial ${machine.memory.serial}, ` +
    `checksum ${machine.memory.verifyChecksum() ? 'ok' : 'BAD'}, ` +
    `${machine.objects.countObjects()} objects]`,
);

/** Run to the next prompt, printing whatever the story produced on the way. */
function runToPrompt(): boolean {
  const result = machine.run();
  if (result.kind === 'quit') return false;
  if (result.kind === 'budget-exhausted') {
    console.error('\n[interpreter: instruction budget exhausted — possible loop]');
    return false;
  }
  if (options.showStatus && pendingStatus !== '') {
    process.stdout.write(`\n[ ${pendingStatus} ]\n`);
  }
  return true;
}

if (options.scriptPath !== undefined) {
  // Scripted mode: feed a canned list of commands and exit. This is how a
  // transcript gets recorded for the regression tests.
  const moves = readFileSync(options.scriptPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const move of moves) {
    if (!runToPrompt()) break;
    process.stdout.write(`>${move}\n`);
    machine.provideInput(move);
  }
  runToPrompt();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt(): void {
  if (!runToPrompt()) {
    rl.close();
    return;
  }
  rl.question('>', (line) => {
    machine.provideInput(line);
    prompt();
  });
}

prompt();
