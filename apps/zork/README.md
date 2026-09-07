# Zork I, in first person

A walkable, clickable Zork I that is still, underneath, exactly Zork I.

The world is rendered in three dimensions and you move through it with the
mouse and WASD. Everything you read is Infocom's text, every rule is Infocom's
code, and the visual layer never gets a vote.

## Running it

```bash
pnpm --filter @deuce/zork dev
```

Then open http://localhost:5173.

The game needs a Zork I story file, which is Infocom's property and is not in
this repository. Either drop `zork1.z3` into `apps/zork/public/` and it loads
automatically, or choose it in the browser when the title screen asks — files
picked that way never leave your machine.

Built against **release 88 / serial 840726**, the version in the Zork
Anthology. The interpreter checks the release on load and refuses a story file
its profile does not describe, rather than misreading it.

## Playing

| | |
|---|---|
| `click` | capture the mouse and look around |
| `W` `A` `S` `D` | walk (hold `Shift` to hurry) |
| walk into a doorway | go that way |
| `E` or left click | interact with whatever the reticle is over |
| click the compass | go that way without walking |
| `Tab` | drop into the command line, and back out again |
| `↑` `↓` | command history |

Anything the original understood can still be typed. That is not a fallback,
it is the point: a puzzle that needs `tie rope to railing` has no gesture, and
inventing one would mean inventing a rule.

## How it works

```
  zork1.z3  ──▶  Machine ──▶ WorldReader ──▶ WorldView ──▶ what you see
  (Infocom)      (v3 VM)     (reads the      (Three.js)
                              object tree)
                    ▲                                │
                    └──────── "north", "take lamp" ◀─┘
```

The loop is one-directional and short. The renderer never changes the game; it
turns what you do into a sentence, hands it to the parser, and redraws
whatever the story says is true afterwards.

This is what makes the boarded front door work without anyone writing code
about boards. Walk at it, the view sends `east`, Infocom's code answers *"The
door is boarded and you can't remove the boards"*, the snapshot comes back with
the same room in it, and the same room is drawn again. No collision rule, no
special case, no chance of the renderer and the game disagreeing.

The same is true of everything else that makes Zork Zork. The thief wanders
and steals on his own schedule. The troll blocks the passages until he doesn't.
The carry limit is enforced by the story file — and because Zork reduces it
when you are wounded, the number in the corner drops from 100 to 90 the first
time the troll connects.

### Layout

| File | |
|---|---|
| `src/main.ts` | the turn loop, and finding a story file |
| `src/scene/view.ts` | camera, lights, movement, and turning input into sentences |
| `src/scene/room.ts` | room geometry, with real openings cut for real exits |
| `src/scene/props.ts` | object meshes and set dressing |
| `src/scene/materials.ts` | procedural surfaces, painted into canvases at load |
| `src/data/roomStyles.ts` | the art direction |
| `src/ui/hud.ts` | room, score, inventory, carry weight, compass |
| `src/ui/console.ts` | transcript and command line |

### Where the invention is

`src/data/roomStyles.ts` is the only file that makes anything up, and it is
confined to appearance: how big a room is, what it is made of, how it is lit,
what is scattered around. No exit, no object and no rule is decided there.

Rooms resolve in three passes — an override for a specific object number, then
one by name, then a family chosen by reading the name — which is how a hundred
and eleven rooms get styled without a hundred and eleven entries. `Twisting
Passage` and `Cold Passage` are both passages and neither needs its own line.

Two decisions in there are worth defending:

**The maze rooms are deliberately identical.** They share a seed, so one is
indistinguishable from the next. Giving them distinct looks would quietly solve
the puzzle, and the maze is the puzzle.

**A room the game calls dark is forced dark**, whatever family it landed in.
The Studio's name puts it with the Kitchen and the Living Room; it is in the
cellar and it is unlit, and a final pass in `styleFor` makes sure the art
direction cannot contradict the story file about the light.

### Exits are read, not guessed

ZIL encodes each direction as a property whose *length* is its type: one byte
goes somewhere, two refuse with a sentence, four consult a global flag, five
consult a door object. So the compass can show the kitchen window as shut and
then as open, and a barred way can be drawn as barred, without simulating
anything — the condition is just read.

## Tests

```bash
pnpm --filter @deuce/zork test
```

The room classifier is checked against the real name of every room in the
game. That test has already earned its keep twice: it caught `/dam/` matching
**Dam**p Cave and flooding a cave with daylight, and it caught Deep Canyon —
which is underground — being styled as open sky.

The interpreter's own tests live in `packages/zmachine`.
