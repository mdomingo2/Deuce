/**
 * Things in rooms.
 *
 * Two different jobs live here. Set dressing comes from the room's style and
 * means nothing to the game: trees, columns, stalactites, the surface of the
 * reservoir. Object meshes stand for real entries in the story file's object
 * tree, and each one carries the object number it represents so that clicking
 * it can be turned into a sentence for the parser.
 *
 * Everything is built from primitives. A recognisable brass lantern is four
 * cylinders and a sphere, and at the light levels Zork runs at that is not
 * only sufficient but arguably better than a detailed model would be — the
 * silhouette is all that survives a single point light at three metres.
 *
 * The fallback matters as much as the named shapes. There are around two
 * hundred objects in Zork I and only a few dozen are worth hand-modelling, so
 * anything unrecognised is built from what the story file already says about
 * it: actors stand up, containers are boxes, and everything else is a small
 * object sized by the bulk the game weighs it at.
 */

import * as THREE from 'three';
import type { ObjectView } from '@deuce/zmachine';
import type { MaterialLibrary } from './materials.js';
import type { PropKind } from '../data/roomStyles.js';

/** Deterministic per-object jitter, so a room looks identical on every visit. */
function hashed(seed: number, salt: number): number {
  let x = (seed * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 0x100000000;
}

// --------------------------------------------------------------- set dressing

/**
 * A tree.
 *
 * Built from a leaning tapered trunk, a few branches and three overlapping
 * canopy masses rather than a cylinder with a ball on top. The lean is the
 * detail that does the most work: a stand of perfectly vertical trunks reads
 * as a colonnade, and a couple of degrees of tilt in different directions
 * turns the same geometry into woodland.
 */
function makeTree(materials: MaterialLibrary, seed: number): THREE.Group {
  const tree = new THREE.Group();
  const height = 5.5 + hashed(seed, 1) * 4.5;
  const bark = materials.get('wood', '#9a7a5e', seed);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.34, height, 7, 3),
    bark,
  );
  trunk.position.y = height / 2;
  // A slight bend, applied by leaning the whole trunk from its base.
  const lean = (hashed(seed, 30) - 0.5) * 0.16;
  const leanAxis = hashed(seed, 31) * Math.PI * 2;
  tree.rotation.set(Math.sin(leanAxis) * lean, 0, Math.cos(leanAxis) * lean);
  tree.add(trunk);

  // A root flare, so the trunk meets the ground instead of stopping at it.
  const flare = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.7, 7), bark);
  flare.position.y = 0.28;
  tree.add(flare);

  // Branches, angled up and out from the upper third of the trunk.
  const branchCount = 3 + Math.floor(hashed(seed, 32) * 3);
  for (let i = 0; i < branchCount; i += 1) {
    const length = 0.9 + hashed(seed, 40 + i) * 1.5;
    const branch = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.09, length, 5),
      bark,
    );
    const angle = (i / branchCount) * Math.PI * 2 + hashed(seed, 50 + i);
    const atHeight = height * (0.5 + hashed(seed, 60 + i) * 0.34);
    const tilt = 0.5 + hashed(seed, 70 + i) * 0.5;

    branch.position.set(
      Math.cos(angle) * length * 0.4,
      atHeight + length * 0.28,
      Math.sin(angle) * length * 0.4,
    );
    branch.rotation.set(Math.sin(angle) * tilt, 0, -Math.cos(angle) * tilt);
    tree.add(branch);
  }

  // Three canopy masses in slightly different greens, so the foliage has
  // internal shape rather than being one silhouette.
  const greens = ['#38452a', '#44502f', '#2f3b24'];
  for (let i = 0; i < 3; i += 1) {
    const radius = 1.3 + hashed(seed, 2 + i) * 1.1;
    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, 1),
      materials.plain(greens[i] ?? '#3d4a2b', { roughness: 1 }),
    );
    canopy.position.set(
      (hashed(seed, 10 + i) - 0.5) * 2.1,
      height * (0.7 + i * 0.13),
      (hashed(seed, 20 + i) - 0.5) * 2.1,
    );
    // Squash slightly: a canopy is wider than it is tall.
    canopy.scale.set(1, 0.78, 1);
    canopy.rotation.y = hashed(seed, 80 + i) * Math.PI;
    tree.add(canopy);
  }

  return tree;
}

/** A stalagmite: the floor's answer to a stalactite. */
function makeStalagmite(materials: MaterialLibrary, seed: number, height: number): THREE.Mesh {
  const spike = new THREE.Mesh(
    new THREE.ConeGeometry(0.16 + hashed(seed, 12) * 0.28, height, 6, 2),
    materials.get('rough-stone', '#7a746a', seed),
  );
  spike.position.y = height / 2;
  spike.rotation.y = hashed(seed, 13) * Math.PI;
  return spike;
}

/**
 * The white house, seen from outside.
 *
 * Only ever a facade: the player is never in a position to walk around it,
 * because the game moves them to a different room before they could.
 */
function makeHouseFacade(materials: MaterialLibrary): THREE.Group {
  const house = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(9, 4.4, 6),
    materials.get('clapboard', '#f2ece0', 900),
  );
  body.position.y = 2.2;
  house.add(body);

  // Boarded windows either side of the door. Zork is emphatic that every way
  // in is shut, and blank clapboard does not say that; boarded glass does.
  for (const sx of [-2.9, 2.9]) {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.5, 0.14),
      materials.plain('#7d7466', { roughness: 0.85 }),
    );
    frame.position.set(sx, 2.5, 3.02);
    house.add(frame);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 1.25, 0.08),
      materials.plain('#14161a', { roughness: 0.4, metalness: 0.2 }),
    );
    glass.position.set(sx, 2.5, 3.08);
    house.add(glass);

    for (let i = 0; i < 2; i += 1) {
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.2, 0.09),
        materials.plain('#6b543c', { roughness: 0.95 }),
      );
      board.position.set(sx, 2.15 + i * 0.72, 3.14);
      board.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.09;
      house.add(board);
    }
  }

  const chimney = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 2.6, 0.9),
    materials.get('brick', '#8a6a58', 901),
  );
  chimney.position.set(-3.1, 5.2, -1.2);
  house.add(chimney);

  // A simple gable, rotated so a four-sided cone reads as a pitched roof.
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(6.4, 2.2, 4),
    materials.plain('#4a3a30', { roughness: 0.95 }),
  );
  roof.position.y = 5.5;
  roof.rotation.y = Math.PI / 4;
  house.add(roof);

  const boardedDoor = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 2.2, 0.16),
    materials.plain('#5a4632', { roughness: 0.9 }),
  );
  boardedDoor.position.set(0, 1.1, 3.05);
  house.add(boardedDoor);

  for (let i = 0; i < 3; i += 1) {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.22, 0.1),
      materials.plain('#6b543c', { roughness: 0.95 }),
    );
    board.position.set(0, 0.55 + i * 0.7, 3.16);
    board.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.06;
    house.add(board);
  }

  return house;
}

function makeColumn(materials: MaterialLibrary, height: number): THREE.Group {
  const column = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.44, 0.5, height * 0.82, 12),
    materials.plain('#8e8a7e', { roughness: 0.6 }),
  );
  shaft.position.y = height * 0.41 + height * 0.06;
  column.add(shaft);

  for (const y of [height * 0.03, height * 0.9]) {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, height * 0.06, 1.3),
      materials.plain('#9a9689', { roughness: 0.55 }),
    );
    block.position.y = y;
    column.add(block);
  }
  return column;
}

function makeStalactite(materials: MaterialLibrary, seed: number, length: number): THREE.Mesh {
  const spike = new THREE.Mesh(
    new THREE.ConeGeometry(0.18 + hashed(seed, 3) * 0.22, length, 5),
    materials.plain('#6b655a', { roughness: 1 }),
  );
  // Cones point up by default; a stalactite hangs.
  spike.rotation.x = Math.PI;
  return spike;
}

function makeRubble(materials: MaterialLibrary, seed: number): THREE.Mesh {
  const size = 0.2 + hashed(seed, 4) * 0.45;
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(size, 1),
    materials.get('rough-stone', '#6e685c', seed),
  );
  rock.rotation.set(hashed(seed, 5) * 3, hashed(seed, 6) * 3, hashed(seed, 7) * 3);
  rock.position.y = size * 0.6;
  return rock;
}

function makeGravestone(materials: MaterialLibrary, seed: number): THREE.Mesh {
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.9 + hashed(seed, 8) * 0.5, 0.14),
    materials.plain('#4e4a4c', { roughness: 0.95 }),
  );
  stone.position.y = 0.55;
  stone.rotation.z = (hashed(seed, 9) - 0.5) * 0.25;
  stone.rotation.y = hashed(seed, 11) * Math.PI;
  return stone;
}

/**
 * Build the set dressing a room's style asks for.
 *
 * Placement is deterministic and keeps a clear disc in the middle of the room
 * so that props never end up standing where the player arrives.
 */
export function buildSetDressing(
  kinds: PropKind[],
  materials: MaterialLibrary,
  room: {
    width: number;
    depth: number;
    height: number;
    seed: number;
    /**
     * Bearings, in radians, that must be left clear.
     *
     * Outdoor rooms have no walls, so the treeline is what tells the player
     * where the ways out are. Planting a trunk across the path north would be
     * worse than useless — it would say there is no exit where there is one.
     */
    clearBearings?: number[];
  },
): THREE.Group {
  const group = new THREE.Group();
  const { width, depth, height, seed } = room;
  const clearBearings = room.clearBearings ?? [];

  /** True if a bearing is close enough to an exit to need leaving alone. */
  const blocksAnExit = (angle: number): boolean =>
    clearBearings.some((bearing) => {
      // Compare on the circle, so 350° and 10° are 20° apart, not 340°.
      const delta = Math.abs(
        Math.atan2(Math.sin(angle - bearing), Math.cos(angle - bearing)),
      );
      return delta < 0.42;
    });

  /** A point out toward the edges of the room, never in the middle. */
  const scatter = (salt: number, inset = 0.9) => {
    const angle = hashed(seed, salt) * Math.PI * 2;
    const radius = 0.45 + hashed(seed, salt + 1) * 0.4;
    return new THREE.Vector3(
      Math.cos(angle) * (width / 2) * radius * inset,
      0,
      Math.sin(angle) * (depth / 2) * radius * inset,
    );
  };

  for (const kind of kinds) {
    switch (kind) {
      case 'trees': {
        // A ring two trees deep around the edge of the clearing, with the
        // bearings of the exits left open. This is the outdoor equivalent of a
        // wall with doorways in it: it encloses the space and tells the player
        // where the ways out are, without putting a barrier around a field.
        const RING = 34;
        for (let i = 0; i < RING; i += 1) {
          const angle = (i / RING) * Math.PI * 2;
          if (blocksAnExit(angle)) continue;

          for (const ring of [1, 1.28]) {
            // Skip about a third of the outer ring so the treeline has depth
            // rather than reading as two concentric fences.
            if (ring > 1 && hashed(seed + i, 700) < 0.35) continue;

            const jitter = (hashed(seed + i, ring > 1 ? 720 : 710) - 0.5) * 0.16;
            const tree = makeTree(materials, seed + i * 31 + Math.round(ring * 100));
            tree.position.set(
              Math.cos(angle + jitter) * (width / 2) * (ring + 0.06),
              0,
              Math.sin(angle + jitter) * (depth / 2) * (ring + 0.06),
            );
            group.add(tree);
          }
        }
        break;
      }
      case 'house-facade': {
        const house = makeHouseFacade(materials);
        // Set well back beyond the north edge. Close enough to dominate the
        // view, far enough that the player is looking at a house rather than
        // at a wall of clapboard.
        house.position.set(0, 0, -depth / 2 - 6.5);
        group.add(house);
        break;
      }
      case 'columns': {
        const inset = 0.62;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 0, 1]) {
            const column = makeColumn(materials, height);
            column.position.set((width / 2) * inset * sx, 0, (depth / 2) * inset * sz);
            group.add(column);
          }
        }
        break;
      }
      case 'stalactites': {
        for (let i = 0; i < 14; i += 1) {
          const length = 0.5 + hashed(seed, 200 + i) * 1.4;
          const spike = makeStalactite(materials, seed + i * 17, length);
          const at = scatter(200 + i * 2, 1);
          spike.position.set(at.x, height - length / 2, at.z);
          group.add(spike);
        }
        // Stalagmites rising to meet them. Without these the ceiling looks
        // like it is growing teeth into an empty room.
        for (let i = 0; i < 7; i += 1) {
          const tall = 0.4 + hashed(seed, 250 + i) * 1.1;
          const spike = makeStalagmite(materials, seed + i * 23, tall);
          const at = scatter(250 + i * 2, 0.95);
          spike.position.x = at.x;
          spike.position.z = at.z;
          group.add(spike);
        }
        break;
      }
      case 'rubble': {
        for (let i = 0; i < 9; i += 1) {
          const rock = makeRubble(materials, seed + i * 13);
          const at = scatter(300 + i * 2);
          rock.position.x = at.x;
          rock.position.z = at.z;
          group.add(rock);
        }
        break;
      }
      case 'boulder': {
        for (let i = 0; i < 4; i += 1) {
          const rock = makeRubble(materials, seed + i * 29);
          rock.scale.setScalar(2.6 + hashed(seed, 400 + i) * 2);
          const at = scatter(400 + i * 2);
          rock.position.x = at.x;
          rock.position.z = at.z;
          group.add(rock);
        }
        break;
      }
      case 'water': {
        // A dark reflective plane just below the floor, so it reads as a body
        // of water the room is standing beside rather than a puddle on it.
        const surface = new THREE.Mesh(
          new THREE.PlaneGeometry(width * 1.6, depth * 0.55),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color('#16323c'),
            roughness: 0.12,
            metalness: 0.6,
            transparent: true,
            opacity: 0.92,
          }),
        );
        surface.rotation.x = -Math.PI / 2;
        surface.position.set(0, -0.18, -depth * 0.36);
        group.add(surface);
        break;
      }
      case 'sand-drift': {
        for (let i = 0; i < 5; i += 1) {
          const drift = new THREE.Mesh(
            new THREE.SphereGeometry(1 + hashed(seed, 500 + i) * 1.6, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
            materials.plain('#8f7d5c', { roughness: 1 }),
          );
          drift.scale.y = 0.22;
          const at = scatter(500 + i * 2);
          drift.position.set(at.x, 0, at.z);
          group.add(drift);
        }
        break;
      }
      case 'timber': {
        // Pit props: the mine's roof supports.
        for (const sx of [-1, 1]) {
          for (const sz of [-0.5, 0.5]) {
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(0.22, height, 0.22),
              materials.plain('#4a3a28', { roughness: 1 }),
            );
            post.position.set((width / 2) * 0.8 * sx, height / 2, depth * sz * 0.7);
            group.add(post);
          }
        }
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.85, 0.22, 0.22),
          materials.plain('#4a3a28', { roughness: 1 }),
        );
        beam.position.y = height - 0.15;
        group.add(beam);
        break;
      }
      case 'coal-seam': {
        for (let i = 0; i < 6; i += 1) {
          const seam = new THREE.Mesh(
            new THREE.BoxGeometry(1.4 + hashed(seed, 600 + i) * 2, 0.5, 0.1),
            materials.plain('#14120f', { roughness: 0.55, metalness: 0.15 }),
          );
          seam.position.set(
            (hashed(seed, 610 + i) - 0.5) * width * 0.7,
            0.6 + hashed(seed, 620 + i) * (height - 1.2),
            -depth / 2 + 0.2,
          );
          group.add(seam);
        }
        break;
      }
      case 'mine-track': {
        for (const sx of [-0.35, 0.35]) {
          const rail = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 0.08, depth),
            materials.plain('#4a4038', { roughness: 0.5, metalness: 0.6 }),
          );
          rail.position.set(sx, 0.05, 0);
          group.add(rail);
        }
        break;
      }
      case 'mirror': {
        const mirror = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 3.4, 0.18),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color('#9aa8b0'),
            roughness: 0.06,
            metalness: 0.95,
          }),
        );
        mirror.position.set(0, 1.9, -depth / 2 + 0.3);
        group.add(mirror);

        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(3, 3.8, 0.12),
          materials.plain('#5a4a34', { roughness: 0.7 }),
        );
        frame.position.set(0, 1.9, -depth / 2 + 0.2);
        group.add(frame);
        break;
      }
      case 'rainbow': {
        // A banded arc. Deliberately unsubtle: it is the one purely beautiful
        // thing in the game and the text makes a point of it.
        const colors = ['#a8425a', '#c47a3a', '#c9b24a', '#4f9a5a', '#3f6fa8', '#6a4a9a'];
        colors.forEach((color, i) => {
          const radius = 9 + i * 0.5;
          const band = new THREE.Mesh(
            new THREE.TorusGeometry(radius, 0.22, 6, 40, Math.PI),
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(color),
              emissive: new THREE.Color(color),
              emissiveIntensity: 0.55,
              roughness: 0.9,
              transparent: true,
              opacity: 0.72,
            }),
          );
          band.position.set(0, 0, -depth * 0.4);
          group.add(band);
        });
        break;
      }
    }
  }

  return group;
}

// -------------------------------------------------------------- game objects

/**
 * A mesh standing for one object in the story file.
 *
 * The returned group carries `userData.objectNumber`, which is what turns a
 * click into "take lamp" for the parser.
 */
export function buildObjectMesh(
  view: ObjectView,
  materials: MaterialLibrary,
): THREE.Group {
  const group = new THREE.Group();
  const name = view.name.toLowerCase();

  const add = (mesh: THREE.Object3D) => group.add(mesh);
  const box = (w: number, h: number, d: number, color: string, opts = {}) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials.plain(color, opts));

  if (name.includes('mailbox')) {
    const post = box(0.12, 1.0, 0.12, '#4a3a2a');
    post.position.y = 0.5;
    add(post);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.5, 10, 1, false, 0, Math.PI),
      materials.plain('#3d4a44', { roughness: 0.6, metalness: 0.3 }),
    );
    body.rotation.z = Math.PI / 2;
    body.position.y = 1.15;
    add(body);
    const base = box(0.5, 0.05, 0.34, '#3d4a44', { metalness: 0.3 });
    base.position.y = 0.92;
    add(base);
  } else if (name.includes('lantern') || name.includes('lamp')) {
    const cage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.13, 0.26, 8),
      materials.plain('#8a6a2e', { roughness: 0.35, metalness: 0.8 }),
    );
    cage.position.y = 0.2;
    add(cage);
    // The glass glows only when the game says the lamp is on.
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      materials.plain(view.providesLight ? '#ffdf9a' : '#6a6252', {
        emissive: view.providesLight ? '#ffca6a' : '#000000',
        emissiveIntensity: view.providesLight ? 1.6 : 0,
        roughness: 0.3,
      }),
    );
    glass.position.y = 0.2;
    add(glass);
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.09, 0.014, 6, 12, Math.PI),
      materials.plain('#8a6a2e', { metalness: 0.8, roughness: 0.35 }),
    );
    handle.position.y = 0.34;
    add(handle);
    const foot = box(0.2, 0.04, 0.2, '#7a5c28', { metalness: 0.7 });
    foot.position.y = 0.05;
    add(foot);
  } else if (name.includes('sword')) {
    const blade = box(0.06, 0.86, 0.02, '#c2ccd4', { metalness: 0.85, roughness: 0.25 });
    blade.position.y = 0.6;
    add(blade);
    const guard = box(0.28, 0.05, 0.05, '#8a7a4a', { metalness: 0.7 });
    guard.position.y = 0.19;
    add(guard);
    const grip = box(0.05, 0.2, 0.05, '#3a2c22');
    grip.position.y = 0.09;
    add(grip);
  } else if (name.includes('knife') || name.includes('stiletto')) {
    const blade = box(0.04, 0.34, 0.015, '#c8ced4', { metalness: 0.85, roughness: 0.2 });
    blade.position.y = 0.28;
    add(blade);
    const grip = box(0.04, 0.14, 0.04, '#2e2822');
    grip.position.y = 0.07;
    add(grip);
  } else if (name.includes('trophy case')) {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.7, 0.5),
      materials.get('wood', '#6b5236', 950),
    );
    frame.position.y = 0.85;
    add(frame);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 1.5, 0.04),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#8fa8b0'),
        transparent: true,
        opacity: 0.18,
        // Barely reflective. At mirror roughness the lantern came back off it
        // as a white sheet that hid the case and half the room behind it.
        roughness: 0.42,
        metalness: 0.1,
      }),
    );
    glass.position.set(0, 0.9, 0.27);
    add(glass);
  } else if (name.includes('rug') || name.includes('carpet')) {
    const rug = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 0.04, 28),
      materials.get('grass', '#7a3330', 952),
    );
    rug.position.y = 0.02;
    rug.scale.z = 0.72;
    add(rug);
    const border = new THREE.Mesh(
      new THREE.TorusGeometry(1.42, 0.05, 6, 24),
      materials.plain('#8a6a3a', { roughness: 0.9 }),
    );
    border.rotation.x = Math.PI / 2;
    border.position.y = 0.05;
    border.scale.z = 0.72;
    add(border);
  } else if (name.includes('table')) {
    const timber = materials.get('plank', '#7d5f3e', 951);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.9), timber);
    top.position.y = 0.78;
    add(top);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.76, 0.09), timber);
        leg.position.set(sx * 0.72, 0.38, sz * 0.36);
        add(leg);
      }
    }
  } else if (name.includes('coffin')) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.55, 0.68),
      materials.get('metal', '#c99a2e', 953),
    );
    body.position.y = 0.3;
    add(body);
    const lid = box(1.94, 0.12, 0.72, '#d4ad46', { metalness: 0.9, roughness: 0.25 });
    lid.position.y = 0.62;
    add(lid);
  } else if (name.includes('egg')) {
    const egg = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 14, 12),
      materials.plain('#c9a33e', { metalness: 0.8, roughness: 0.22 }),
    );
    egg.scale.y = 1.45;
    egg.position.y = 0.23;
    add(egg);
  } else if (name.includes('bottle')) {
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 0.3, 10),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#9ac4bc'),
        transparent: true,
        opacity: 0.45,
        roughness: 0.1,
      }),
    );
    bottle.position.y = 0.15;
    add(bottle);
    const neck = box(0.05, 0.1, 0.05, '#9ac4bc');
    neck.position.y = 0.34;
    add(neck);
  } else if (name.includes('sack') || name.includes('bag')) {
    const sack = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      materials.plain('#7d6a4a', { roughness: 1 }),
    );
    sack.scale.set(0.85, 1.15, 0.85);
    sack.position.y = 0.24;
    add(sack);
  } else if (name.includes('rope') || name.includes('coil')) {
    const rope = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.05, 6, 18),
      materials.plain('#8a7448', { roughness: 1 }),
    );
    rope.rotation.x = Math.PI / 2;
    rope.position.y = 0.06;
    add(rope);
  } else if (name.includes('door') || name.includes('grating') || name.includes('window')) {
    const panel = box(1.1, 1.9, 0.1, '#5a4632', { roughness: 0.9 });
    panel.position.y = 0.95;
    add(panel);
  } else if (view.actor) {
    // A humanoid stand-in. The troll, the thief and the cyclops all get the
    // same build with different proportions and colour, which is enough to
    // read as a person-shaped threat at lantern range.
    const isLarge = name.includes('cyclops');
    const scale = isLarge ? 1.45 : 1;
    const tone = name.includes('troll')
      ? '#4e5a3e'
      : name.includes('thief')
        ? '#3a3440'
        : name.includes('cyclops')
          ? '#7a6248'
          : '#4a4a52';

    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28 * scale, 0.7 * scale, 4, 8),
      materials.plain(tone, { roughness: 0.9 }),
    );
    torso.position.y = 1.05 * scale;
    add(torso);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.21 * scale, 12, 10),
      materials.plain(tone, { roughness: 0.85 }),
    );
    head.position.y = 1.68 * scale;
    add(head);

    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.11 * scale, 0.5 * scale, 4, 6),
        materials.plain(tone, { roughness: 0.9 }),
      );
      leg.position.set(sx * 0.15 * scale, 0.42 * scale, 0);
      add(leg);

      const arm = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.09 * scale, 0.52 * scale, 4, 6),
        materials.plain(tone, { roughness: 0.9 }),
      );
      arm.position.set(sx * 0.4 * scale, 1.1 * scale, 0);
      arm.rotation.z = sx * 0.18;
      add(arm);
    }

    // The cyclops has one eye, and it should be the thing that catches the light.
    const eyeCount = isLarge ? 1 : 2;
    for (let i = 0; i < eyeCount; i += 1) {
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(isLarge ? 0.07 : 0.035, 8, 6),
        materials.plain('#e8d8a0', { emissive: '#c8a040', emissiveIntensity: 0.8 }),
      );
      eye.position.set(
        eyeCount === 1 ? 0 : (i === 0 ? -0.08 : 0.08) * scale,
        1.72 * scale,
        0.19 * scale,
      );
      add(eye);
    }
  } else if (view.container) {
    const size = Math.max(0.3, Math.min(1.1, 0.25 + view.size * 0.02));
    const chest = box(size * 1.4, size, size, '#5e4a34', { roughness: 0.8 });
    chest.position.y = size / 2;
    add(chest);
    if (!view.open) {
      const lid = box(size * 1.44, 0.06, size * 1.04, '#4a3a28');
      lid.position.y = size + 0.03;
      add(lid);
    }
  } else {
    // The generic fallback: a small faceted object sized by the bulk the game
    // assigns it, so a heavy thing looks heavy without needing a model.
    const radius = Math.max(0.1, Math.min(0.42, 0.09 + view.size * 0.008));
    const blob = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, 0),
      materials.plain(view.takeable ? '#8a8070' : '#5c5850', { roughness: 0.85 }),
    );
    blob.position.y = radius;
    blob.rotation.set(
      hashed(view.number, 1) * 3,
      hashed(view.number, 2) * 3,
      hashed(view.number, 3) * 3,
    );
    add(blob);
  }

  group.userData['objectNumber'] = view.number;
  group.userData['objectName'] = view.name;
  return group;
}

/**
 * Lay the room's contents out on the floor.
 *
 * Placement is a ring biased away from the middle so that arriving in a room
 * never drops the player on top of something, and it is seeded by the object
 * number so the lamp is in the same corner every time you come back.
 */
export function placeObjects(
  views: ObjectView[],
  materials: MaterialLibrary,
  room: { width: number; depth: number },
): { group: THREE.Group; targets: THREE.Object3D[] } {
  const group = new THREE.Group();
  const targets: THREE.Object3D[] = [];

  views.forEach((view, index) => {
    const mesh = buildObjectMesh(view, materials);

    // Spread evenly around a circle, then jitter, so two objects in the same
    // room cannot land on the same spot.
    const angle =
      (index / Math.max(1, views.length)) * Math.PI * 2 + hashed(view.number, 40) * 0.7;
    // Out toward the walls, but not against them. Closer in and arriving in
    // the Living Room puts the trophy case about a metre from your nose, which
    // both blows out under the lantern and hides the room behind it.
    const radius = 0.55 + hashed(view.number, 41) * 0.16;

    mesh.position.set(
      Math.cos(angle) * (room.width / 2) * radius,
      0,
      Math.sin(angle) * (room.depth / 2) * radius,
    );
    mesh.rotation.y = hashed(view.number, 42) * Math.PI * 2;

    group.add(mesh);
    targets.push(mesh);
  });

  return { group, targets };
}
