/**
 * Procedural surfaces.
 *
 * One convention runs through the whole file and is worth stating before the
 * recipes: **a base colour carries lightness, and the per-room tint carries
 * hue and darkening.** Tints multiply, so a base that starts dark cannot be
 * lifted by any tint — it can only be pushed further down. Authoring the rock
 * base at near-black and expecting a mid-grey tint to bring it back produced
 * cave walls at RGB (28, 25, 22), which is black in all but name, and left the
 * lantern doing work that no amount of intensity could do without blowing out
 * everything within a metre of it.
 *
 * There are a hundred and ten rooms in Zork I and no art budget, so every
 * texture here is painted into a canvas at load time rather than fetched.
 * That buys three things: the whole game is one JavaScript bundle with no
 * asset pipeline, a surface can be tinted per room without duplicating an
 * image, and the noise can be seeded so a wall looks the same on every visit.
 *
 * The palettes lean deliberately dark and desaturated. Zork is lit by one
 * brass lantern for most of its length, and a texture that looks good in a
 * bright viewport turns to mud under a single point light — so these are
 * authored for the light they will actually be seen in.
 */

import * as THREE from 'three';

const TEXTURE_SIZE = 256;

/**
 * A small deterministic generator.
 *
 * `Math.random` would give a wall a different grain every time the room is
 * rebuilt, which is visible as a shimmer when walking in and out of a room.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Smooth value noise, used as the base grain under most surfaces. */
function valueNoise(width: number, height: number, cells: number, seed: number): number[] {
  const random = makeRandom(seed);
  const grid: number[] = [];
  const gridSize = cells + 1;
  for (let i = 0; i < gridSize * gridSize; i += 1) grid.push(random());

  const smooth = (t: number) => t * t * (3 - 2 * t);
  const out: number[] = new Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fx = (x / width) * cells;
      const fy = (y / height) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);

      // Wrap the lattice so the texture tiles without a visible seam.
      const wrap = (v: number) => v % cells;
      const at = (gx: number, gy: number) => grid[wrap(gy) * gridSize + wrap(gx)] ?? 0;

      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[y * width + x] = top * (1 - ty) + bottom * ty;
    }
  }

  return out;
}

/** Several octaves of value noise summed, for a more natural grain. */
function fractalNoise(width: number, height: number, seed: number): number[] {
  const octaves = [
    { cells: 4, weight: 0.5 },
    { cells: 8, weight: 0.28 },
    { cells: 16, weight: 0.14 },
    { cells: 32, weight: 0.08 },
  ];

  const out = new Array<number>(width * height).fill(0);
  octaves.forEach((octave, index) => {
    const layer = valueNoise(width, height, octave.cells, seed + index * 7919);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = (out[i] ?? 0) + (layer[i] ?? 0) * octave.weight;
    }
  });

  return out;
}

function createCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  // Every surface is read back twice — once for the height field and once for
  // the normal map — so the browser is told up front to keep the buffer where
  // the CPU can reach it rather than round-tripping the GPU each time.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D context to paint textures into.');
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Repeat stays at one: tiling is done by scaling each mesh's UVs to its own
  // size, which is the only way to keep texel density even across the game.
  texture.repeat.set(1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export type SurfaceKind =
  | 'clapboard'
  | 'stone'
  | 'rough-stone'
  | 'earth'
  | 'grass'
  | 'wood'
  | 'plank'
  | 'brick'
  | 'marble'
  | 'sand'
  | 'water'
  | 'metal'
  | 'ice';

interface SurfaceRecipe {
  /** Base colour before noise is applied. */
  base: string;
  /** How far the noise pushes the colour, 0..1. */
  contrast: number;
  roughness: number;
  metalness: number;
  /**
   * Metres covered by one tile of the texture.
   *
   * Expressed in world units rather than as a repeat count because a repeat
   * count is per *face*: the same material on a ten-metre wall and a
   * two-metre one would stretch to five times the size on the first. Callers
   * scale each mesh's UVs by its real dimensions divided by this, so a stone
   * block is the same size everywhere in the game.
   */
  tileSize: number;
  /**
   * How hard the derived normal map pushes, 0..3.
   *
   * This is the single biggest lever on how a surface reads under the lantern.
   * Flat albedo lit by one moving point light looks like painted card; give the
   * same texture relief and the light starts raking across it. Cave rock wants
   * a lot, polished marble almost none.
   */
  normalStrength: number;
  /** How much the surface's darker parts also read as rougher, 0..1. */
  roughnessVariance?: number;
  paint?: (ctx: CanvasRenderingContext2D, seed: number) => void;
}

/** Draw a running-bond course of blocks, used for brick and cut stone. */
function paintMasonry(
  ctx: CanvasRenderingContext2D,
  seed: number,
  options: { rows: number; cols: number; mortar: string; jitter: number },
): void {
  const random = makeRandom(seed);
  const h = TEXTURE_SIZE / options.rows;
  const w = TEXTURE_SIZE / options.cols;

  ctx.strokeStyle = options.mortar;
  ctx.lineWidth = 2;

  for (let row = 0; row < options.rows; row += 1) {
    const y = row * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEXTURE_SIZE, y);
    ctx.stroke();

    // Every other course is offset by half a block, which is what makes
    // masonry read as masonry rather than as a grid.
    const offset = row % 2 === 0 ? 0 : w / 2;
    for (let col = 0; col <= options.cols; col += 1) {
      const x = col * w + offset;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h);
      ctx.stroke();

      // A faint per-block tint stops the courses looking machine-made.
      if (random() < options.jitter) {
        ctx.fillStyle = `rgba(0, 0, 0, ${(random() * 0.16).toFixed(3)})`;
        ctx.fillRect(x, y, w, h);
      }
    }
  }
}

/** Draw long grain lines for timber. */
function paintGrain(ctx: CanvasRenderingContext2D, seed: number, planks: number): void {
  const random = makeRandom(seed);
  const plankHeight = TEXTURE_SIZE / planks;

  for (let p = 0; p < planks; p += 1) {
    const y0 = p * plankHeight;
    ctx.fillStyle = `rgba(0, 0, 0, ${(0.05 + random() * 0.1).toFixed(3)})`;
    ctx.fillRect(0, y0, TEXTURE_SIZE, plankHeight);

    // The seam between boards.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(TEXTURE_SIZE, y0);
    ctx.stroke();

    // Grain lines wandering along the board.
    for (let g = 0; g < 7; g += 1) {
      const gy = y0 + random() * plankHeight;
      ctx.strokeStyle = `rgba(0, 0, 0, ${(0.08 + random() * 0.12).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let x = 0; x <= TEXTURE_SIZE; x += 16) {
        ctx.lineTo(x, gy + Math.sin((x / TEXTURE_SIZE) * Math.PI * 2 + g) * 1.6);
      }
      ctx.stroke();
    }
  }
}

const RECIPES: Record<SurfaceKind, SurfaceRecipe> = {
  /**
   * Painted weatherboard, for the white house.
   *
   * It needs its own recipe rather than a tinted `plank` because tints
   * multiply: no tint can turn brown timber into white paint, and the very
   * first line of the game calls it a white house.
   */
  clapboard: {
    base: '#cfc9ba',
    contrast: 0.1,
    roughness: 0.78,
    metalness: 0,
    tileSize: 1.5,
    normalStrength: 1.0,
    roughnessVariance: 0.14,
    paint: (ctx, seed) => paintGrain(ctx, seed, 7),
  },
  stone: {
    base: '#adaca8',
    contrast: 0.3,
    roughness: 0.92,
    metalness: 0,
    tileSize: 2.4,
    normalStrength: 1.9,
    roughnessVariance: 0.3,
    paint: (ctx, seed) =>
      paintMasonry(ctx, seed, { rows: 8, cols: 5, mortar: 'rgba(0,0,0,0.4)', jitter: 0.5 }),
  },
  'rough-stone': {
    // The natural cave rock that most of the underground is cut from.
    base: '#a9a49b',
    contrast: 0.55,
    roughness: 1,
    metalness: 0,
    tileSize: 3.2,
    normalStrength: 2.6,
    roughnessVariance: 0.34,
  },
  earth: {
    // Bright enough that a mid tint still lands on soil rather than on tar:
    // the tint multiplies this, so whatever the base loses cannot be given
    // back further down.
    base: '#8a7258',
    contrast: 0.42,
    roughness: 1,
    metalness: 0,
    tileSize: 3.0,
    normalStrength: 2.2,
    roughnessVariance: 0.3,
  },
  grass: {
    base: '#93a86a',
    contrast: 0.38,
    roughness: 1,
    metalness: 0,
    tileSize: 2.2,
    normalStrength: 1.7,
    roughnessVariance: 0.22,
  },
  wood: {
    base: '#9c7554',
    contrast: 0.2,
    roughness: 0.8,
    metalness: 0,
    tileSize: 1.8,
    normalStrength: 1.1,
    roughnessVariance: 0.2,
    paint: (ctx, seed) => paintGrain(ctx, seed, 6),
  },
  plank: {
    base: '#a8815e',
    contrast: 0.18,
    roughness: 0.75,
    metalness: 0,
    tileSize: 1.6,
    normalStrength: 1.2,
    roughnessVariance: 0.22,
    paint: (ctx, seed) => paintGrain(ctx, seed, 9),
  },
  brick: {
    base: '#b0796a',
    contrast: 0.22,
    roughness: 0.88,
    metalness: 0,
    tileSize: 2.0,
    normalStrength: 1.8,
    roughnessVariance: 0.28,
    paint: (ctx, seed) =>
      paintMasonry(ctx, seed, { rows: 12, cols: 6, mortar: 'rgba(190,180,165,0.28)', jitter: 0.6 }),
  },
  marble: {
    // The temple and the treasure rooms, where the empire spent money.
    base: '#cfccc2',
    contrast: 0.16,
    roughness: 0.35,
    metalness: 0.05,
    tileSize: 2.8,
    normalStrength: 0.35,
    roughnessVariance: 0.1,
  },
  sand: {
    base: '#c4b294',
    contrast: 0.24,
    roughness: 1,
    metalness: 0,
    tileSize: 2.6,
    normalStrength: 1.5,
    roughnessVariance: 0.18,
  },
  water: {
    base: '#1e3a44',
    contrast: 0.2,
    roughness: 0.16,
    metalness: 0.4,
    tileSize: 3.5,
    normalStrength: 0.6,
    roughnessVariance: 0.05,
  },
  metal: {
    base: '#9aa0a6',
    contrast: 0.18,
    roughness: 0.42,
    metalness: 0.85,
    tileSize: 2.0,
    normalStrength: 0.7,
    roughnessVariance: 0.14,
  },
  ice: {
    base: '#b3cdd6',
    contrast: 0.14,
    roughness: 0.2,
    metalness: 0.1,
    tileSize: 2.4,
    normalStrength: 0.5,
    roughnessVariance: 0.08,
  },
};

/**
 * Read a painted canvas back as a height field.
 *
 * Using luminance as height is a cheat, but a well-behaved one for these
 * surfaces: the noise that darkens a patch of rock is the same noise that
 * would dent it, and the mortar lines painted between stones are exactly the
 * grooves that should catch a shadow. It also means the relief automatically
 * agrees with the colour, which a separately generated height map would not.
 */
function heightFromCanvas(ctx: CanvasRenderingContext2D): Float32Array {
  const { data } = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const height = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);

  for (let i = 0; i < height.length; i += 1) {
    const p = i * 4;
    // Rec. 601 luma: green carries most of the perceived brightness.
    height[i] =
      ((data[p] ?? 0) * 0.299 + (data[p + 1] ?? 0) * 0.587 + (data[p + 2] ?? 0) * 0.114) / 255;
  }
  return height;
}

/**
 * Sobel the height field into a tangent-space normal map.
 *
 * Sampling wraps at the edges so the normal map tiles as seamlessly as the
 * colour it came from — a seam here would draw a hard lit line across every
 * wall in the game at the tile boundary.
 */
function normalMapFrom(height: Float32Array, strength: number): THREE.Texture {
  const { canvas, ctx } = createCanvas();
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const { data } = image;

  const at = (x: number, y: number): number => {
    const wx = ((x % TEXTURE_SIZE) + TEXTURE_SIZE) % TEXTURE_SIZE;
    const wy = ((y % TEXTURE_SIZE) + TEXTURE_SIZE) % TEXTURE_SIZE;
    return height[wy * TEXTURE_SIZE + wx] ?? 0;
  };

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));

      // Normalise (dx, dy, 1/strength) and pack into 0..255 per channel.
      const nz = 1 / Math.max(0.05, strength);
      const length = Math.hypot(dx, dy, nz) || 1;
      const p = (y * TEXTURE_SIZE + x) * 4;
      data[p] = ((dx / length) * 0.5 + 0.5) * 255;
      data[p + 1] = ((dy / length) * 0.5 + 0.5) * 255;
      data[p + 2] = ((nz / length) * 0.5 + 0.5) * 255;
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = toTexture(canvas);
  // A normal map holds vectors, not colour, and must not be gamma-decoded.
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/**
 * Turn the height field into a roughness map.
 *
 * Recessed, darker areas — mortar, the pits in rock — hold dirt and scatter
 * more, so they read as rougher than the faces around them. It is a small
 * effect but it stops a surface looking uniformly matte, which is most of what
 * gives cheap 3D away.
 */
function roughnessMapFrom(height: Float32Array, base: number, variance: number): THREE.Texture {
  const { canvas, ctx } = createCanvas();
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const { data } = image;

  for (let i = 0; i < height.length; i += 1) {
    const value = THREE.MathUtils.clamp(
      base + (0.5 - (height[i] ?? 0.5)) * variance,
      0.04,
      1,
    );
    const p = i * 4;
    data[p] = data[p + 1] = data[p + 2] = value * 255;
    data[p + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  const texture = toTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/** Albedo, relief and roughness for one surface, generated together. */
interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function buildTexture(kind: SurfaceKind, seed: number): SurfaceMaps {
  const recipe = RECIPES[kind];
  const { canvas, ctx } = createCanvas();

  ctx.fillStyle = recipe.base;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // Grain first, so painted detail (mortar, plank seams) sits on top of it.
  const noise = fractalNoise(TEXTURE_SIZE, TEXTURE_SIZE, seed);
  const image = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const { data } = image;

  for (let i = 0; i < noise.length; i += 1) {
    // Centre the noise on zero so it darkens and lightens rather than only
    // darkening, which would wash the base colour out.
    const shift = ((noise[i] ?? 0.5) - 0.5) * 2 * recipe.contrast * 255;
    const p = i * 4;
    data[p] = Math.max(0, Math.min(255, (data[p] ?? 0) + shift));
    data[p + 1] = Math.max(0, Math.min(255, (data[p + 1] ?? 0) + shift));
    data[p + 2] = Math.max(0, Math.min(255, (data[p + 2] ?? 0) + shift));
  }
  ctx.putImageData(image, 0, 0);

  recipe.paint?.(ctx, seed + 104_729);

  // The height field is read back *after* painting, so mortar lines and plank
  // seams become grooves in the relief rather than only marks in the colour.
  const height = heightFromCanvas(ctx);

  return {
    map: toTexture(canvas),
    normalMap: normalMapFrom(height, recipe.normalStrength),
    roughnessMap: roughnessMapFrom(
      height,
      recipe.roughness,
      recipe.roughnessVariance ?? 0.25,
    ),
  };
}

/**
 * Caches materials by surface and tint.
 *
 * Rooms reuse a handful of surfaces, and Three.js will happily upload the same
 * texture a hundred times if asked, so everything is shared and disposed
 * together when the world is torn down.
 */
export class MaterialLibrary {
  private readonly surfaces = new Map<string, SurfaceMaps>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();

  /**
   * A material for one surface, optionally tinted.
   *
   * Tinting multiplies the texture rather than replacing it, so the Troll
   * Room and the Cellar can share one rock texture and still read as
   * different places.
   */
  get(kind: SurfaceKind, tint = '#ffffff', seed = 1): THREE.MeshStandardMaterial {
    const surfaceKey = `${kind}:${seed}`;
    let surface = this.surfaces.get(surfaceKey);
    if (!surface) {
      surface = buildTexture(kind, seed);
      this.surfaces.set(surfaceKey, surface);
    }

    const materialKey = `${surfaceKey}:${tint}`;
    let material = this.materials.get(materialKey);
    if (!material) {
      const recipe = RECIPES[kind];
      material = new THREE.MeshStandardMaterial({
        map: surface.map,
        normalMap: surface.normalMap,
        roughnessMap: surface.roughnessMap,
        color: new THREE.Color(tint),
        // roughness multiplies the map, so it stays at one and lets the map
        // carry the whole range rather than compressing it.
        roughness: 1,
        metalness: recipe.metalness,
      });
      this.materials.set(materialKey, material);
    }

    return material;
  }

  /** A flat, untextured material, for props and small details. */
  plain(
    color: string,
    options: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } = {},
  ): THREE.MeshStandardMaterial {
    const key = `plain:${color}:${JSON.stringify(options)}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: options.roughness ?? 0.7,
        metalness: options.metalness ?? 0.1,
        ...(options.emissive ? { emissive: new THREE.Color(options.emissive) } : {}),
        ...(options.emissiveIntensity !== undefined
          ? { emissiveIntensity: options.emissiveIntensity }
          : {}),
      });
      this.materials.set(key, material);
    }
    return material;
  }

  dispose(): void {
    for (const surface of this.surfaces.values()) {
      surface.map.dispose();
      surface.normalMap.dispose();
      surface.roughnessMap.dispose();
    }
    for (const material of this.materials.values()) material.dispose();
    this.surfaces.clear();
    this.materials.clear();
  }
}

/**
 * Metres covered by one tile of a surface's texture.
 *
 * Geometry builders divide each face's real dimensions by this and scale the
 * mesh's UVs, so texel density stays even whether the face is a two-metre
 * maze wall or a twenty-metre dam.
 */
export function tileSizeOf(kind: SurfaceKind): number {
  return RECIPES[kind].tileSize;
}

/**
 * A sky for outdoor rooms.
 *
 * `scene.background` set to a flat colour gives a horizon that is the same
 * value straight up as it is at eye level, which no real sky has ever done and
 * which reads instantly as a rendered backdrop. An equirectangular gradient
 * costs one small canvas and puts the light where the eye expects it: brighter
 * toward the horizon, deeper overhead.
 *
 * Zork's outdoors is overcast New England, so the gradient is narrow and grey
 * rather than a travel-poster blue.
 */
export function skyTexture(zenith: string, horizon: string): THREE.Texture {
  const width = 16;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context to paint the sky into.');

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, zenith);
  gradient.addColorStop(0.55, horizon);
  // Below the horizon the "sky" is only ever seen through fog at the very edge
  // of the ground plane, so it darkens rather than continuing to brighten.
  gradient.addColorStop(1, '#4e5359');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
