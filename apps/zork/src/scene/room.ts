/**
 * Building a room out of a style and a list of exits.
 *
 * Rooms are boxes, but the openings are real geometry rather than painted-on
 * doors: a wall carrying an exit is built as the solid pieces *around* the
 * opening plus a lintel over it, so the player can see through into the fog
 * beyond and walk out without passing through a surface. That matters more
 * than it sounds — a first-person Zork lives or dies on being able to tell at
 * a glance which way is out, and in a room lit by one lantern the only cue
 * that reads is a hole with darkness behind it.
 *
 * Vertical exits get the same treatment through the floor and ceiling, which
 * is how the trap door in the Living Room ends up being an actual hole you
 * stand at the edge of.
 *
 * One unit is one metre and the camera's eye sits 1.7 of them above the floor.
 */

import * as THREE from 'three';
import type { Direction, Exit } from '@deuce/zmachine';
import { tileSizeOf, type MaterialLibrary } from './materials.js';
import { displaceGeometry, segmentsFor } from './displace.js';
import type { RoomStyle } from '../data/roomStyles.js';

export const EYE_HEIGHT = 1.7;
const WALL_THICKNESS = 0.35;
const DOOR_WIDTH = 1.7;
const DOOR_HEIGHT = 2.25;
/** Vertical openings are square and generous enough to see down. */
const SHAFT_SIZE = 2.2;

/** Where a doorway sits and whether the game will let the player through. */
export interface Doorway {
  direction: Direction;
  /** Centre of the opening, at floor level. */
  position: THREE.Vector3;
  /** Unit vector pointing out through the opening. */
  facing: THREE.Vector3;
  passable: boolean;
  /** What to say about it: a destination, or the game's refusal. */
  label: string;
  /** Vertical exits are entered by standing on them, not walking at them. */
  vertical: boolean;
}

export interface BuiltRoom {
  group: THREE.Group;
  doorways: Doorway[];
  /** Half-extents the camera is kept inside. */
  bounds: { halfWidth: number; halfDepth: number };
  /** Floor openings the player should not simply walk over. */
  pits: { x: number; z: number; size: number }[];
}

/**
 * Which wall an exit belongs on, and where along it.
 *
 * Diagonals share a wall with their cardinal neighbour, offset toward the
 * corner they point at. Putting north-east on the north wall's right-hand side
 * keeps the geometry to four walls while still pointing the player the right
 * way; a true corner opening would need mitred geometry for very little gain.
 */
const WALL_PLACEMENT: Record<
  Direction,
  { wall: 'north' | 'south' | 'east' | 'west' | 'ceiling' | 'floor'; offset: number }
> = {
  north: { wall: 'north', offset: 0 },
  northeast: { wall: 'north', offset: 0.62 },
  northwest: { wall: 'north', offset: -0.62 },
  south: { wall: 'south', offset: 0 },
  southeast: { wall: 'south', offset: 0.62 },
  southwest: { wall: 'south', offset: -0.62 },
  east: { wall: 'east', offset: 0 },
  west: { wall: 'west', offset: 0 },
  up: { wall: 'ceiling', offset: 0 },
  down: { wall: 'floor', offset: 0 },
  // "In" and "out" have no compass direction. They are given the east and west
  // walls' upper corners so they never collide with a real cardinal exit.
  in: { wall: 'east', offset: 0.66 },
  out: { wall: 'west', offset: 0.66 },
};

/**
 * Rescale a geometry's UVs so its texture tiles at a fixed size in metres.
 *
 * Box and plane UVs run 0..1 across each face regardless of how large the face
 * is, so without this a ten-metre wall and a one-metre one would show the same
 * number of stone blocks at wildly different sizes. Doing it per mesh rather
 * than on the shared texture is what lets every room reuse one material.
 */
function tileUVs(geometry: THREE.BufferGeometry, uMetres: number, vMetres: number, tile: number): void {
  const uv = geometry.getAttribute('uv');
  if (!uv) return;
  const uScale = Math.max(0.25, uMetres / tile);
  const vScale = Math.max(0.25, vMetres / tile);
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i) * uScale, uv.getY(i) * vScale);
  }
  uv.needsUpdate = true;
}

/** A rectangle in a wall's local 2D space. */
interface Opening {
  centre: number;
  width: number;
  height: number;
}

/**
 * Split a wall into the solid pieces left over once its openings are cut.
 *
 * Returns rectangles in wall-local coordinates: `u` runs along the wall from
 * its left edge, `v` upward from the floor.
 */
function wallSegments(
  wallWidth: number,
  wallHeight: number,
  openings: Opening[],
): { u: number; v: number; w: number; h: number }[] {
  const pieces: { u: number; v: number; w: number; h: number }[] = [];
  const sorted = [...openings].sort((a, b) => a.centre - b.centre);

  let cursor = 0;
  for (const opening of sorted) {
    const left = Math.max(0, opening.centre - opening.width / 2);
    const right = Math.min(wallWidth, opening.centre + opening.width / 2);
    if (left > cursor) {
      pieces.push({ u: cursor, v: 0, w: left - cursor, h: wallHeight });
    }
    // The lintel: the strip of wall above the opening.
    if (opening.height < wallHeight && right > left) {
      pieces.push({
        u: left,
        v: opening.height,
        w: right - left,
        h: wallHeight - opening.height,
      });
    }
    cursor = Math.max(cursor, right);
  }

  if (cursor < wallWidth) {
    pieces.push({ u: cursor, v: 0, w: wallWidth - cursor, h: wallHeight });
  }

  return pieces;
}

/**
 * Split a horizontal plane into the rectangles left once a hole is cut.
 *
 * Laid out as a three-by-three grid around the hole with the middle cell
 * missing, which handles a hole anywhere including one pushed against an edge
 * (the degenerate rows and columns come out zero-sized and are dropped).
 */
function planeWithHole(
  width: number,
  depth: number,
  hole: { x: number; z: number; size: number } | null,
): { x: number; z: number; w: number; d: number }[] {
  if (!hole) return [{ x: 0, z: 0, w: width, d: depth }];

  const half = hole.size / 2;
  const xs = [-width / 2, hole.x - half, hole.x + half, width / 2];
  const zs = [-depth / 2, hole.z - half, hole.z + half, depth / 2];

  const rects: { x: number; z: number; w: number; d: number }[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 1 && col === 1) continue; // the hole itself

      const x0 = xs[col] ?? 0;
      const x1 = xs[col + 1] ?? 0;
      const z0 = zs[row] ?? 0;
      const z1 = zs[row + 1] ?? 0;
      const w = x1 - x0;
      const d = z1 - z0;
      if (w <= 0.01 || d <= 0.01) continue;

      rects.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, w, d });
    }
  }
  return rects;
}

/** Whether the game will currently let the player through this exit. */
function exitIsPassable(exit: Exit): boolean {
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

function exitLabel(exit: Exit): string {
  switch (exit.kind) {
    case 'plain':
      return exit.toName;
    case 'blocked':
      // The game's own sentence, trimmed to something that fits a label.
      return exit.message.replace(/\s+/g, ' ').trim();
    case 'conditional':
      return exit.passable ? exit.toName : exit.message.replace(/\s+/g, ' ').trim() || 'Blocked';
    case 'door':
      return exit.passable ? exit.toName : `${exit.doorName} is closed`;
    case 'computed':
      return '';
  }
}

export function buildRoom(
  style: RoomStyle,
  exits: Exit[],
  materials: MaterialLibrary,
): BuiltRoom {
  const group = new THREE.Group();
  const { width, depth, seed } = style;

  /**
   * A room with no ceiling is outdoors, and outdoors must not be a box.
   *
   * Four full-height walls around a forest clearing means no sky and no
   * horizon, which is what made the first version of West of House look like
   * a cellar with a house in it. Outdoor rooms instead get a low bank of
   * earth at the edges — high enough to still carry doorway openings and to
   * stop the player wandering off the floor, low enough that the sky and the
   * fog do the work of suggesting distance.
   */
  const open = style.ceiling === null;
  const height = open ? 1.7 : style.height;

  const floorMat = materials.get(style.floor, style.floorTint, seed);
  const wallMat = materials.get(style.walls, style.wallTint, seed + 1);
  const ceilingMat = style.ceiling
    ? materials.get(style.ceiling, style.ceilingTint, seed + 2)
    : null;

  const doorways: Doorway[] = [];
  const pits: { x: number; z: number; size: number }[] = [];

  // Group exits by the wall they land on so each wall is built once.
  const perWall = new Map<string, { exit: Exit; offset: number }[]>();
  let ceilingHole: { x: number; z: number; size: number } | null = null;
  let floorHole: { x: number; z: number; size: number } | null = null;

  for (const exit of exits) {
    const placement = WALL_PLACEMENT[exit.direction];
    if (placement.wall === 'ceiling') {
      // Pushed off-centre so the player is not standing in the shaft on
      // arrival, and so the two can coexist in a room with both.
      ceilingHole = { x: -width * 0.22, z: -depth * 0.22, size: SHAFT_SIZE };
      doorways.push({
        direction: exit.direction,
        position: new THREE.Vector3(ceilingHole.x, 0, ceilingHole.z),
        facing: new THREE.Vector3(0, 1, 0),
        passable: exitIsPassable(exit),
        label: exitLabel(exit),
        vertical: true,
      });
      continue;
    }
    if (placement.wall === 'floor') {
      floorHole = { x: width * 0.24, z: depth * 0.24, size: SHAFT_SIZE };
      pits.push(floorHole);
      doorways.push({
        direction: exit.direction,
        position: new THREE.Vector3(floorHole.x, 0, floorHole.z),
        facing: new THREE.Vector3(0, -1, 0),
        passable: exitIsPassable(exit),
        label: exitLabel(exit),
        vertical: true,
      });
      continue;
    }

    const list = perWall.get(placement.wall) ?? [];
    list.push({ exit, offset: placement.offset });
    perWall.set(placement.wall, list);
  }

  // ------------------------------------------------------------ floor/ceiling

  // Outdoors the ground runs past the boundary so the player never sees the
  // edge of the world over the top of a low bank.
  const floorWidth = open ? width * 3 : width;
  const floorDepth = open ? depth * 3 : depth;
  const rough = style.irregular ?? 0;
  for (const rect of planeWithHole(floorWidth, floorDepth, floorHole)) {
    const geometry = new THREE.PlaneGeometry(
      rect.w,
      rect.d,
      segmentsFor(rect.w),
      segmentsFor(rect.d),
    );
    tileUVs(geometry, rect.w, rect.d, tileSizeOf(style.floor));
    const rotation = new THREE.Euler(-Math.PI / 2, 0, 0);
    // The floor gets much less than the walls: the camera's eye height is
    // fixed, so a floor that rolls underneath makes the player look like they
    // are hovering rather than walking.
    displaceGeometry(geometry, {
      amount: rough * 0.09,
      scale: 3.4,
      offset: new THREE.Vector3(rect.x, 0, rect.z),
      rotation,
      pinEdges: true,
    });
    const mesh = new THREE.Mesh(geometry, floorMat);
    mesh.rotation.copy(rotation);
    mesh.position.set(rect.x, 0, rect.z);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (ceilingMat) {
    for (const rect of planeWithHole(width, depth, ceilingHole)) {
      const geometry = new THREE.PlaneGeometry(
        rect.w,
        rect.d,
        segmentsFor(rect.w),
        segmentsFor(rect.d),
      );
      tileUVs(geometry, rect.w, rect.d, tileSizeOf(style.ceiling ?? 'stone'));
      const rotation = new THREE.Euler(Math.PI / 2, 0, 0);
      // The roof of a cave can be as broken as it likes — nobody walks on it,
      // and a jagged ceiling is most of what sells a space as underground.
      displaceGeometry(geometry, {
        amount: rough * 0.5,
        scale: 2.6,
        offset: new THREE.Vector3(rect.x, height, rect.z),
        rotation,
        pinEdges: true,
      });
      const mesh = new THREE.Mesh(geometry, ceilingMat);
      mesh.rotation.copy(rotation);
      mesh.position.set(rect.x, height, rect.z);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // A rim around a floor opening, so the edge catches the lantern and reads as
  // a drop rather than as a dark patch of floor.
  if (floorHole) {
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(SHAFT_SIZE * 0.72, SHAFT_SIZE * 0.86, 4, 1),
      materials.plain('#2a2620', { roughness: 0.9 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.rotation.z = Math.PI / 4;
    rim.position.set(floorHole.x, 0.02, floorHole.z);
    group.add(rim);

    // A shallow box of darkness under the hole, so looking down shows depth.
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(SHAFT_SIZE, 6, SHAFT_SIZE),
      materials.plain('#05060a', { roughness: 1 }),
    );
    shaft.position.set(floorHole.x, -3.05, floorHole.z);
    shaft.material.side = THREE.BackSide;
    group.add(shaft);
  }

  // ------------------------------------------------------------------- walls

  const walls = [
    { key: 'north', length: width, normal: new THREE.Vector3(0, 0, 1), z: -depth / 2, x: 0, rotY: 0 },
    { key: 'south', length: width, normal: new THREE.Vector3(0, 0, -1), z: depth / 2, x: 0, rotY: Math.PI },
    { key: 'east', length: depth, normal: new THREE.Vector3(-1, 0, 0), z: 0, x: width / 2, rotY: -Math.PI / 2 },
    { key: 'west', length: depth, normal: new THREE.Vector3(1, 0, 0), z: 0, x: -width / 2, rotY: Math.PI / 2 },
  ] as const;

  for (const wall of walls) {
    const entries = perWall.get(wall.key) ?? [];

    const openings: Opening[] = entries.map(({ offset }) => ({
      // Convert the -1..1 offset into a position along the wall, keeping the
      // whole doorway inside the wall even in a narrow room.
      centre: THREE.MathUtils.clamp(
        wall.length / 2 + (offset * wall.length) / 2,
        DOOR_WIDTH / 2,
        wall.length - DOOR_WIDTH / 2,
      ),
      width: DOOR_WIDTH,
      // A gap in a 1.7m bank is the full height of the bank; indoors it is a
      // door-shaped hole with a lintel above it.
      height: open ? height : Math.min(DOOR_HEIGHT, height - 0.2),
    }));

    // Outdoors there is no wall to build. The doorways below are still
    // recorded so that walking toward an edge leaves the room, but the edge
    // itself is drawn as a treeline by the set dressing instead of as a bank
    // of earth — a 1.7m wall around a field reads as a pit, not as a clearing.
    for (const piece of open ? [] : wallSegments(wall.length, height, openings)) {
      const geometry = new THREE.BoxGeometry(
        piece.w,
        piece.h,
        WALL_THICKNESS,
        segmentsFor(piece.w),
        segmentsFor(piece.h),
        1,
      );
      tileUVs(geometry, piece.w, piece.h, tileSizeOf(style.walls));

      // Position in wall-local space, then rotate the whole thing into place.
      const along = piece.u + piece.w / 2 - wall.length / 2;
      const localY = piece.v + piece.h / 2;
      const sideways = wall.key === 'east' || wall.key === 'west';
      const placeAt = sideways
        ? new THREE.Vector3(wall.x, localY, along)
        : new THREE.Vector3(along, localY, wall.z);
      const rotation = new THREE.Euler(0, sideways ? Math.PI / 2 : 0, 0);

      // Walls carry the most displacement of anything. The wall is thicker
      // than the amount it moves, so however lumpy it gets it never opens a
      // hole into the void behind the room.
      displaceGeometry(geometry, {
        amount: rough * 0.24,
        scale: 2.4,
        offset: placeAt,
        rotation,
        pinEdges: false,
      });

      const mesh = new THREE.Mesh(geometry, wallMat);
      mesh.position.copy(placeAt);
      mesh.rotation.copy(rotation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    // Record where each doorway ended up, for movement triggers and labels.
    entries.forEach(({ exit }, index) => {
      const opening = openings[index];
      if (!opening) return;
      const along = opening.centre - wall.length / 2;
      const position =
        wall.key === 'north' || wall.key === 'south'
          ? new THREE.Vector3(along, 0, wall.z)
          : new THREE.Vector3(wall.x, 0, along);

      doorways.push({
        direction: exit.direction,
        position,
        facing: wall.normal.clone().negate(),
        passable: exitIsPassable(exit),
        label: exitLabel(exit),
        vertical: false,
      });

      // A blocked exit gets a visible barrier filling the opening, so the
      // player can see that the way is shut rather than walking into nothing.
      if (!exitIsPassable(exit) && !open) {
        const barrier = new THREE.Mesh(
          new THREE.BoxGeometry(DOOR_WIDTH * 0.98, opening.height * 0.98, 0.12),
          materials.plain(exit.kind === 'door' ? '#5b452f' : '#3e3a34', {
            roughness: 0.85,
          }),
        );
        barrier.position.copy(position);
        barrier.position.y = opening.height / 2;
        if (wall.key === 'east' || wall.key === 'west') barrier.rotation.y = Math.PI / 2;
        group.add(barrier);
      } else if (!open) {
        // A short length of passage behind the opening, seen from inside.
        //
        // A flat black rectangle reads as a sticker on the wall — it has no
        // parallax, so it stays the same shape as the player moves and the
        // doorway never feels like a hole. A box with its faces flipped
        // inward is a real tunnel: the lantern falls off down it, the fog
        // gathers in it, and the far end genuinely recedes.
        const tunnel = new THREE.Mesh(
          new THREE.BoxGeometry(DOOR_WIDTH, opening.height, 3.4),
          materials.get(style.walls, style.wallTint, seed + 5),
        );
        tunnel.material.side = THREE.BackSide;
        tunnel.position.copy(position);
        tunnel.position.y = opening.height / 2;
        // Pushed outward so it starts inside the wall and runs away from the
        // room, and rotated to lie along the direction of travel.
        tunnel.position.addScaledVector(wall.normal, -1.7 - WALL_THICKNESS / 2);
        if (wall.key === 'east' || wall.key === 'west') tunnel.rotation.y = Math.PI / 2;
        group.add(tunnel);

        // A cap at the far end, so a lit passage does not show the void.
        const cap = new THREE.Mesh(
          new THREE.PlaneGeometry(DOOR_WIDTH, opening.height),
          materials.plain('#05060a', { roughness: 1 }),
        );
        cap.position.copy(position);
        cap.position.y = opening.height / 2;
        cap.position.addScaledVector(wall.normal, -3.4 - WALL_THICKNESS / 2);
        if (wall.key === 'east' || wall.key === 'west') cap.rotation.y = Math.PI / 2;
        group.add(cap);
      }
    });
  }

  return {
    group,
    doorways,
    bounds: { halfWidth: width / 2 - 0.6, halfDepth: depth / 2 - 0.6 },
    pits,
  };
}
