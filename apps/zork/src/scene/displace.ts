/**
 * Pushing flat geometry out of shape.
 *
 * A room built from boxes and planes reads as a room built from boxes and
 * planes, however good the texture on it. Under a single moving lantern the
 * thing that gives a cave away is not the colour of the rock, it is that every
 * silhouette is a straight line and every corner is ninety degrees.
 *
 * So surfaces that are supposed to be cut out of living rock get their
 * vertices displaced along their own normals by a noise field sampled in
 * *world* space. Sampling in world space rather than per mesh is what makes a
 * wall and the floor it meets bulge in agreement instead of tearing apart at
 * the join.
 *
 * Displacement is deliberately modest — the walls are thick enough to absorb
 * it, so no amount of lumpiness opens a hole into the void behind a room.
 */

import * as THREE from 'three';

/** A cheap, stable 3D hash in the range 0..1. */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Smoothly interpolated value noise over a 3D lattice. */
function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);

  const smooth = (t: number) => t * t * (3 - 2 * t);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const tz = smooth(z - zi);

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const corner = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), tx);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), tx);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), tx);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), tx);

  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
}

/** Two octaves, which is enough to look geological without looking noisy. */
function fbm3(x: number, y: number, z: number): number {
  return valueNoise3(x, y, z) * 0.65 + valueNoise3(x * 2.3, y * 2.3, z * 2.3) * 0.35;
}

export interface DisplaceOptions {
  /** Peak displacement in metres. Zero leaves the geometry untouched. */
  amount: number;
  /** Size in metres of one lump. Larger is smoother. */
  scale?: number;
  /**
   * Where the mesh will sit, so the noise is sampled in world space.
   *
   * Geometry is displaced before it is positioned, so the offset has to be
   * supplied rather than read back off the mesh.
   */
  offset?: THREE.Vector3;
  /** Rotation the mesh will be given, for the same reason. */
  rotation?: THREE.Euler;
  /**
   * Pin the outer edge of the surface in place.
   *
   * A floor that undulates all the way to the wall leaves a gap you can see
   * daylight through; fading the displacement out over the last stretch keeps
   * the join sealed while the middle of the surface still rolls.
   */
  pinEdges?: boolean;
}

/**
 * Displace a geometry's vertices along their normals.
 *
 * Recomputes normals afterwards, which also smooth-shades the result — for
 * rock that is what you want, since a displaced box with hard face normals
 * still reads as a box with dents in it.
 */
export function displaceGeometry(
  geometry: THREE.BufferGeometry,
  options: DisplaceOptions,
): void {
  const { amount } = options;
  if (amount <= 0) return;

  const scale = options.scale ?? 2.2;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!position || !normal) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const matrix = new THREE.Matrix4();
  if (options.rotation) matrix.makeRotationFromEuler(options.rotation);
  const offset = options.offset ?? new THREE.Vector3();

  const local = new THREE.Vector3();
  const world = new THREE.Vector3();

  for (let i = 0; i < position.count; i += 1) {
    local.fromBufferAttribute(position, i);

    // Where this vertex will end up once the mesh is placed, so neighbouring
    // surfaces sample the same field and bulge together.
    world.copy(local).applyMatrix4(matrix).add(offset);
    const noise = fbm3(world.x / scale, world.y / scale, world.z / scale) - 0.5;

    let falloff = 1;
    if (options.pinEdges && box) {
      // Distance to the nearest edge, as a fraction of the surface's extent.
      const spanX = Math.max(0.001, box.max.x - box.min.x);
      const spanY = Math.max(0.001, box.max.y - box.min.y);
      const edgeX = Math.min(local.x - box.min.x, box.max.x - local.x) / spanX;
      const edgeY = Math.min(local.y - box.min.y, box.max.y - local.y) / spanY;
      falloff = THREE.MathUtils.smoothstep(Math.min(edgeX, edgeY), 0, 0.18);
    }

    const push = noise * 2 * amount * falloff;
    position.setXYZ(
      i,
      local.x + normal.getX(i) * push,
      local.y + normal.getY(i) * push,
      local.z + normal.getZ(i) * push,
    );
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

/**
 * How many segments a surface of this size needs to displace convincingly.
 *
 * Too few and the lumps are visibly polygonal; too many and a room costs more
 * vertices than the whole rest of the scene. One segment every 40cm, capped,
 * is the point where more stops being visible.
 */
export function segmentsFor(metres: number, cap = 24): number {
  return Math.max(1, Math.min(cap, Math.round(metres / 0.4)));
}
