# @deuce/zmachine

A Z-machine version 3 interpreter, and a reader that turns a running story into
a world you can draw.

Point it at any v3 story file and it will run it. Nothing in the interpreter
knows anything about Zork.

## Why this exists

`apps/zork` needed a world model for a first-person Zork I. The alternative was
to hand-write one — the rooms, the puzzles, the thief, the carry limit, all
transcribed from reference material — and every one of those is a chance to
drift from the original. Executing Infocom's own story file makes drift
impossible. The renderer can only ever show what the 1981 code decided.

## Using it

```ts
import { Machine, WorldReader, ZORK1_R88 } from '@deuce/zmachine';

const machine = new Machine(storyBytes, {
  onOutput: (text) => process.stdout.write(text),
});
const reader = new WorldReader(machine, ZORK1_R88);

machine.run();                        // runs until the story wants input
machine.provideInput('open mailbox');
machine.run();

const world = reader.snapshot();
world.room.name;        // 'West of House'
world.exits;            // north → North of House, east → blocked, ...
world.carried.bulk;     // what the game weighs you at
world.lit;              // false means a grue is a live possibility
```

There is also a terminal driver, which is how the interpreter is exercised
independently of any graphics:

```bash
pnpm --filter @deuce/zmachine play -- stories/zork1.z3
pnpm --filter @deuce/zmachine play -- stories/zork1.z3 --script moves.txt --seed 7
```

## Two things that are not in the spec

**`run()` never blocks.** A conventional interpreter's read-a-line opcode stops
the world and waits on stdin, which a browser cannot do. Instead `run()`
returns when the story asks for input, leaving the program counter parked past
the read instruction; the host renders frames, collects a command whenever it
likes, and calls `provideInput()` to fill in the buffers the read was going to
fill. The story cannot tell it was suspended.

**The RNG is a seeded xorshift.** Zork's combat, the thief's wandering and the
maze's hazards all run through it, so a fixed seed makes a playthrough
replayable — which is the only practical way to regression-test a game this
stateful.

## The world reader

The interpreter deals in bytes. It does not know that property 31 means "north"
or that attribute 20 means "this is giving off light" — those are conventions
of the ZIL compiler and of the game, not of the Z-machine. `WorldReader` takes
a `StoryProfile` naming them and produces a snapshot.

It only ever *reads*. Picking something up is not an operation it offers; the
host types `take lamp` at the parser and lets the original code decide. A
snapshot can lag the game by at most a turn and can never contradict it.

### The Zork I profile was recovered, not looked up

The ZIL compiler assigns property numbers per build, so a table borrowed from a
different release would be quietly wrong. Everything in `zork1.ts` came out of
the story file itself, and the tests re-derive it:

| | how it was found |
|---|---|
| directions (20–31) | West of House's property 31 holds North of House's object number; the Kitchen's 23 leads to the Attic and its 22 down the chimney |
| value (13) | the Kitchen carries 10 and the Cellar 25 — exactly what the score does on first entering each |
| size (15) | gold coffin 55, sword 30, lantern 15, leaflet 2 |
| light (attr 20) | the lantern gains it on `turn on lamp` and loses it on `turn off lamp` |
| open (attr 11) | the mailbox and the kitchen window each gain it when opened |
| lit (global 66) | flips to 0 when the lamp goes out in the Cellar, and does not move when the lamp is toggled somewhere already lit |
| load allowance (global 133) | 100, and it falls to 90 on exactly the turn `diagnose` starts reporting a wound |

That last one is the nicest find. Zork I's carry limit is not a constant: being
injured genuinely reduces what you can carry, so the number the interface shows
drops after a bad fight with the troll.

## Tests

```bash
pnpm --filter @deuce/zmachine test
```

Unit tests build tiny synthetic story images, so a failure points at one opcode
rather than at "Zork is broken". Beyond that the real story file is played:
scoring, darkness and the grue, the troll fight, a save/restore round trip
through v3's branch-on-restore semantics, and the parser's six-Z-character
truncation — which is why `frobozzle` gets an answer about FROBOZZ.

**The story file is copyrighted and is not in this repository.** Tests that
need it skip themselves when it is absent, so a clean checkout still gets a
green run. Drop `zork1-r88-s840726.z3` into `stories/` to enable them.
