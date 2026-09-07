/**
 * Procedural surfaces.
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
  const ctx = canvas.getContext('2d');
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
  stone: {
    base: '#4a4a48',
    contrast: 0.3,
    roughness: 0.92,
    metalness: 0,
    tileSize: 2.4,
    paint: (ctx, seed) =>
      paintMasonry(ctx, seed, { rows: 8, cols: 5, mortar: 'rgba(0,0,0,0.4)', jitter: 0.5 }),
  },
  'rough-stone': {
    // The natural cave rock that most of the underground is cut from.
    base: '#3c3a36',
    contrast: 0.55,
    roughness: 1,
    metalness: 0,
    tileSize: 3.2,
  },
  earth: {
    base: '#4a3c2e',
    contrast: 0.42,
    roughness: 1,
    metalness: 0,
    tileSize: 3.0,
  },
  grass: {
    base: '#3f4a2c',
    contrast: 0.38,
    roughness: 1,
    metalness: 0,
    tileSize: 2.2,
  },
  wood: {
    base: '#5a4130',
    contrast: 0.2,
    roughness: 0.8,
    metalness: 0,
    tileSize: 1.8,
    paint: (ctx, seed) => paintGrain(ctx, seed, 6),
  },
  plank: {
    base: '#6b4f38',
    contrast: 0.18,
    roughness: 0.75,
    metalness: 0,
    tileSize: 1.6,
    paint: (ctx, seed) => paintGrain(ctx, seed, 9),
  },
  brick: {
    base: '#6b3f33',
    contrast: 0.22,
    roughness: 0.88,
    metalness: 0,
    tileSize: 2.0,
    paint: (ctx, seed) =>
      paintMasonry(ctx, seed, { rows: 12, cols: 6, mortar: 'rgba(190,180,165,0.28)', jitter: 0.6 }),
  },
  marble: {
    // The temple and the treasure rooms, where the empire spent money.
    base: '#8d8a80',
    contrast: 0.16,
    roughness: 0.35,
    metalness: 0.05,
    tileSize: 2.8,
  },
  sand: {
    base: '#7a6a4e',
    contrast: 0.24,
    roughness: 1,
    metalness: 0,
    tileSize: 2.6,
  },
  water: {
    base: '#1e3a44',
    contrast: 0.2,
    roughness: 0.16,
    metalness: 0.4,
    tileSize: 3.5,
  },
  metal: {
    base: '#54585c',
    contrast: 0.18,
    roughness: 0.42,
    metalness: 0.85,
    tileSize: 2.0,
  },
  ice: {
    base: '#6f8b96',
    contrast: 0.14,
    roughness: 0.2,
    metalness: 0.1,
    tileSize: 2.4,
  },
};

function buildTexture(kind: SurfaceKind, seed: number): THREE.Texture {
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

  return toTexture(canvas);
}

/**
 * Caches materials by surface and tint.
 *
 * Rooms reuse a handful of surfaces, and Three.js will happily upload the same
 * texture a hundred times if asked, so everything is shared and disposed
 * together when the world is torn down.
 */
export class MaterialLibrary {
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();

  /**
   * A material for one surface, optionally tinted.
   *
   * Tinting multiplies the texture rather than replacing it, so the Troll
   * Room and the Cellar can share one rock texture and still read as
   * different places.
   */
  get(kind: SurfaceKind, tint = '#ffffff', seed = 1): THREE.MeshStandardMaterial {
    const textureKey = `${kind}:${seed}`;
    let texture = this.textures.get(textureKey);
    if (!texture) {
      texture = buildTexture(kind, seed);
      this.textures.set(textureKey, texture);
    }

    const materialKey = `${textureKey}:${tint}`;
    let material = this.materials.get(materialKey);
    if (!material) {
      const recipe = RECIPES[kind];
      material = new THREE.MeshStandardMaterial({
        map: texture,
        color: new THREE.Color(tint),
        roughness: recipe.roughness,
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
    for (const texture of this.textures.values()) texture.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.textures.clear();
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
