/**
 * Dust in the lantern beam.
 *
 * A point light in an empty room lights surfaces and nothing in between, so
 * the air reads as vacuum. Real lamplight underground is full of motes, and
 * putting a few hundred of them in front of the camera does something no
 * amount of surface detail can: it gives the light a *volume*, and it gives
 * the player a sense of motion when they walk across a room whose far wall is
 * too dark to track against.
 *
 * The particles follow the camera rather than belonging to the room. That is a
 * cheat — the same speck is with you all game — but it means a fixed, small
 * budget covers every room, and the alternative (filling a whole room with
 * particles, most of them out of sight in the dark) costs far more to look
 * identical.
 */

import * as THREE from 'three';

/** How far from the camera motes are kept. Beyond this the lantern is dim. */
const FIELD = 7;

export interface Dust {
  points: THREE.Points;
  update: (delta: number, camera: THREE.Camera) => void;
  dispose: () => void;
}

/** A soft round blob, so motes are not visible squares. */
function moteTexture(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context for the dust sprite.');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createDust(count = 420): Dust {
  const positions = new Float32Array(count * 3);
  const drift = new Float32Array(count * 3);
  const scale = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * FIELD * 2;
    positions[i * 3 + 1] = (Math.random() - 0.5) * FIELD * 2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * FIELD * 2;

    // Mostly falling, but slowly and with a sideways wander, so the field
    // stirs rather than raining.
    drift[i * 3] = (Math.random() - 0.5) * 0.16;
    drift[i * 3 + 1] = -0.05 - Math.random() * 0.11;
    drift[i * 3 + 2] = (Math.random() - 0.5) * 0.16;

    scale[i] = 0.5 + Math.random() * 0.9;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const texture = moteTexture();
  const material = new THREE.PointsMaterial({
    size: 0.035,
    map: texture,
    transparent: true,
    opacity: 0.5,
    // Additive so motes only ever brighten, and are invisible where there is
    // no light to catch — which is exactly how dust behaves.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    color: new THREE.Color('#d8c39a'),
  });

  const points = new THREE.Points(geometry, material);
  // The field is re-centred on the camera every frame, so culling it against
  // its original bounds would make it disappear as soon as the player moved.
  points.frustumCulled = false;

  const centre = new THREE.Vector3();

  function update(delta: number, camera: THREE.Camera): void {
    camera.getWorldPosition(centre);
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;

    for (let i = 0; i < count; i += 1) {
      const p = i * 3;
      array[p] = (array[p] ?? 0) + (drift[p] ?? 0) * delta;
      array[p + 1] = (array[p + 1] ?? 0) + (drift[p + 1] ?? 0) * delta;
      array[p + 2] = (array[p + 2] ?? 0) + (drift[p + 2] ?? 0) * delta;

      // Wrap each axis around the camera, so the field always surrounds the
      // player however far they have walked.
      for (let axis = 0; axis < 3; axis += 1) {
        const index = p + axis;
        const origin = axis === 0 ? centre.x : axis === 1 ? centre.y : centre.z;
        const relative = (array[index] ?? 0) - origin;
        if (relative > FIELD) array[index] = origin - FIELD;
        else if (relative < -FIELD) array[index] = origin + FIELD;
      }
    }

    attribute.needsUpdate = true;
    void scale;
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
    texture.dispose();
  }

  return { points, update, dispose };
}
