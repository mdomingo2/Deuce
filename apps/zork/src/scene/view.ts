/**
 * The first-person view.
 *
 * This owns the camera, the lights and the room currently standing in the
 * scene, and it converts what the player does with the mouse and keyboard into
 * *sentences*. That last part is the whole design: walking through the north
 * doorway does not move the player, it sends "north" to the parser, and the
 * player only actually moves when the game says they did. Everything the
 * renderer knows arrives as a `WorldSnapshot` after the fact.
 *
 * Keeping it that way is what makes a blocked exit behave correctly without
 * any special handling. Walk at the boarded door and the game answers "The
 * door is boarded and you can't remove the boards", the snapshot comes back
 * with the same room in it, and the view rebuilds the same room. No collision
 * rule had to know about boards.
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Direction, Exit, ObjectView, WorldSnapshot } from '@deuce/zmachine';

import { MaterialLibrary, skyTexture } from './materials.js';
import { buildRoom, EYE_HEIGHT, type BuiltRoom } from './room.js';
import { buildSetDressing, placeObjects } from './props.js';
import { createDust, type Dust } from './dust.js';
import { styleFor, type RoomStyle } from '../data/roomStyles.js';

const WALK_SPEED = 3.6;
/** How close to a doorway counts as walking through it. */
const DOORWAY_TRIGGER = 1.15;
/**
 * Ignore doorways briefly after arriving in a room.
 *
 * Without this, spawning near the doorway you came in through would re-trigger
 * it and bounce the player back and forth between two rooms forever.
 */
const ARRIVAL_GRACE_MS = 550;
/** Radians of rotation per pixel of mouse travel. */
const LOOK_SENSITIVITY = 0.0025;

/**
 * Which way the player is facing after travelling in each direction.
 *
 * North is -Z, matching the convention the room builder uses to lay walls out,
 * so that "north" on the compass, the north wall and the direction the camera
 * turns to are all the same thing.
 */
const TRAVEL_VECTOR: Record<Direction, THREE.Vector3> = {
  north: new THREE.Vector3(0, 0, -1),
  south: new THREE.Vector3(0, 0, 1),
  east: new THREE.Vector3(1, 0, 0),
  west: new THREE.Vector3(-1, 0, 0),
  northeast: new THREE.Vector3(0.7, 0, -0.7),
  northwest: new THREE.Vector3(-0.7, 0, -0.7),
  southeast: new THREE.Vector3(0.7, 0, 0.7),
  southwest: new THREE.Vector3(-0.7, 0, 0.7),
  // Arriving vertically or through a door leaves no compass heading, so the
  // player is simply turned to face into the room.
  up: new THREE.Vector3(0, 0, -1),
  down: new THREE.Vector3(0, 0, -1),
  in: new THREE.Vector3(0, 0, -1),
  out: new THREE.Vector3(0, 0, -1),
};

/** Where the camera should stand when arriving from a given direction. */
const OPPOSITE: Record<Direction, Direction> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  northeast: 'southwest',
  southwest: 'northeast',
  northwest: 'southeast',
  southeast: 'northwest',
  up: 'down',
  down: 'up',
  in: 'out',
  out: 'in',
};

export interface ViewCallbacks {
  /** The player tried to leave in a direction. Send it to the parser. */
  onMove: (direction: Direction) => void;
  /** The player interacted with an object. */
  onInteract: (objectNumber: number, objectName: string) => void;
  /** What the reticle is currently over, for the focus label. */
  onFocus: (label: string | null) => void;
}

export class WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: PointerLockControls;
  private readonly materials = new MaterialLibrary();
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private dust: Dust | null = null;
  /** Cached per palette, since only a handful of skies are ever used. */
  private readonly skies = new Map<string, THREE.Texture>();

  /** Everything belonging to the current room, torn down on a room change. */
  private roomGroup: THREE.Group | null = null;
  /**
   * Just the objects lying in the room, rebuilt on every turn.
   *
   * Kept separate from the shell because the shell is expensive — displacing
   * and re-normalising every wall runs over tens of thousands of vertices, and
   * doing that on each turn to notice that the thief has taken a coin is most
   * of a frame wasted.
   */
  private objectLayer: THREE.Group | null = null;
  private objectRoom = -1;
  private lastExitSignature = '';
  private built: BuiltRoom | null = null;
  private interactables: THREE.Object3D[] = [];

  private ambient = new THREE.AmbientLight(0xffffff, 0.1);
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x404040, 0);
  /** Daylight. Only ever on above ground. */
  private sun = new THREE.DirectionalLight(0xf0e4cc, 0);
  /**
   * Light belonging to a room that lights itself.
   *
   * Ambient light alone cannot do this job. Since Three.js moved to physical
   * light units an AmbientLight bright enough to see by is also flat enough to
   * erase every edge in the room, so a self-lit interior gets a real source
   * near its ceiling and the ambient is left as fill.
   */
  private roomLight = new THREE.PointLight(0xffe6bc, 0, 30, 1.1);
  /** The brass lantern, carried by the camera. */
  private lantern = new THREE.PointLight(0xffca7a, 0, 26, 1.25);

  private readonly pressed = new Set<string>();
  private arrivedAt = 0;
  private lastDirection: Direction | null = null;
  private movementLocked = false;
  private typing = false;
  private focused: string | null = null;
  /** Set while the left button is held and the pointer is not locked. */
  private dragging: { x: number; y: number; travelled: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: ViewCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // Percentage-closer filtering: a point light's shadow map is a cube and
    // cannot be large, so the softening is what keeps its edges from reading
    // as stair-steps across a wall.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Zork lives at the bottom of the exposure range, so a filmic curve keeps
    // the lantern's falloff from clipping to flat black.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.08,
      220,
    );
    this.camera.position.set(0, EYE_HEIGHT, 0);

    this.controls = new PointerLockControls(this.camera, canvas);
    this.scene.add(this.controls.object);

    // Held low and slightly forward, the way a lantern actually is. Placing
    // it at eye level lights the walls but leaves the floor black, which is
    // disorienting to walk around in.
    this.lantern.position.set(0.25, -0.45, -0.2);
    // The lantern is the only thing casting underground, and cast shadow is
    // most of what makes a lantern feel like a lantern — the rubble on the
    // floor throws a shape, and the shape moves when you do.
    this.lantern.castShadow = true;
    this.lantern.shadow.mapSize.set(512, 512);
    this.lantern.shadow.camera.near = 0.15;
    this.lantern.shadow.camera.far = 26;
    // Shadow acne on displaced rock is much worse than a little peter-panning.
    this.lantern.shadow.bias = -0.006;
    this.lantern.shadow.normalBias = 0.04;
    this.camera.add(this.lantern);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // A directional light's default shadow frustum is a 10-metre box, which is
    // smaller than any outdoor room here — the edge of it showed up as a hard
    // lit rectangle across the front of the white house.
    this.sun.shadow.camera.left = -34;
    this.sun.shadow.camera.right = 34;
    this.sun.shadow.camera.top = 34;
    this.sun.shadow.camera.bottom = -34;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 90;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.ambient, this.hemisphere, this.sun, this.roomLight);

    this.dust = createDust();
    this.scene.add(this.dust.points);

    // Post-processing. Bloom is doing real work here rather than being a
    // flourish: a bare point light in a dark room clips to a flat disc of
    // colour, and letting the brightest part bleed is what turns that disc
    // back into something that reads as a flame behind glass.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.6,
      0.7,
      0.72,
    );
    this.composer.addPass(this.bloom);
    // OutputPass applies tone mapping and the colour-space conversion that the
    // renderer would otherwise have done on its own.
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    canvas.addEventListener('mousedown', this.handleClick);
    // On window rather than the canvas, so a drag that wanders over the HUD
    // keeps turning instead of sticking.
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
  }

  // -------------------------------------------------------------- pointer lock

  /**
   * Ask for the pointer, and shrug if the answer is no.
   *
   * `requestPointerLock` returns a promise in current browsers and rejects
   * when the page is not allowed to have it — an iframe without the
   * `pointer-lock` permission, most commonly. Left unhandled that is an
   * uncaught rejection in the console; here it just means the drag fallback
   * does the work instead.
   */
  lock(): void {
    try {
      this.controls.lock();
    } catch {
      // Nothing to do: dragging still turns the camera.
    }
  }

  unlock(): void {
    this.controls.unlock();
  }

  get isLocked(): boolean {
    return this.controls.isLocked;
  }

  onLockChange(listener: (locked: boolean) => void): void {
    this.controls.addEventListener('lock', () => listener(true));
    this.controls.addEventListener('unlock', () => listener(false));
  }

  /**
   * Suspend doorway triggers.
   *
   * Used while a turn is being executed, so that holding W through a doorway
   * queues one command rather than a dozen.
   */
  setMovementLocked(locked: boolean): void {
    this.movementLocked = locked;
  }

  /**
   * Stop reading movement keys while the player is writing a command.
   *
   * Without pointer lock there is nothing else to tell "w" meaning walk from
   * "w" meaning west being typed into the prompt.
   */
  setTyping(typing: boolean): void {
    this.typing = typing;
    if (typing) this.pressed.clear();
  }

  // ------------------------------------------------------------------- rooms

  /**
   * Replace the scene with the room in this snapshot.
   *
   * `cameFrom` positions the player at the far side of the room, so walking
   * north into a room leaves them standing at its southern edge looking north
   * — which is the only arrangement that makes a corridor feel continuous.
   */
  setRoom(snapshot: WorldSnapshot, cameFrom: Direction | null): void {
    this.teardownRoom();

    const style = styleFor(snapshot.room.number, snapshot.room.name, snapshot.room.selfLit);
    const built = buildRoom(style, snapshot.exits, this.materials);

    const group = new THREE.Group();
    group.add(built.group);
    const dressing = buildSetDressing(style.props, this.materials, {
      width: style.width,
      depth: style.depth,
      height: style.height,
      seed: style.seed,
      // Outdoors the treeline stands in for walls, so it needs to know which
      // bearings are ways out and must be left clear.
      clearBearings: built.doorways
        .filter((doorway) => !doorway.vertical)
        .map((doorway) => Math.atan2(doorway.position.z, doorway.position.x)),
    });
    group.add(dressing);

    // Scenery the room declares is drawn but not made clickable — the white
    // house and the staircase are things to look at, and the game answers for
    // them through the parser if the player asks.
    const visible: ObjectView[] = snapshot.contents;
    const { group: objectGroup, targets } = placeObjects(visible, this.materials, {
      width: style.width,
      depth: style.depth,
    });
    group.add(objectGroup);
    this.objectLayer = objectGroup;
    this.objectRoom = snapshot.room.number;
    this.lastExitSignature = this.exitSignature(snapshot);

    // Set dressing and objects both cast and receive. The room shell sets its
    // own flags in the builder, deliberately leaving the black planes behind
    // doorways out of it — those exist to be dark, and a slab of darkness that
    // also casts a shadow would put a hole in the floor of the next room.
    for (const shadowed of [dressing, objectGroup]) {
      shadowed.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
    }

    this.scene.add(group);
    this.roomGroup = group;
    this.built = built;
    this.interactables = targets;

    this.applyLighting(snapshot, style);
    this.placeCamera(built, style, cameFrom);

    this.arrivedAt = performance.now();
  }

  /**
   * Refresh a room in place, without moving the player.
   *
   * A turn that does not change rooms still changes the world — a door opens,
   * the lamp goes on, the thief takes something — so the room is rebuilt but
   * the camera is left exactly where it was.
   */
  refreshRoom(snapshot: WorldSnapshot): void {
    // The shell only has to be rebuilt when something about the room's *shape*
    // changed — which, since exits are read from the story file, means a door
    // opening or a flag flipping. Comparing the exit signature catches that
    // without rebuilding a cave's worth of displaced rock every turn.
    const shellStale =
      !this.roomGroup ||
      this.objectRoom !== snapshot.room.number ||
      this.exitSignature(snapshot) !== this.lastExitSignature;

    if (shellStale) {
      const position = this.controls.object.position.clone();
      const quaternion = this.camera.quaternion.clone();

      this.setRoom(snapshot, null);

      this.controls.object.position.copy(position);
      this.camera.quaternion.copy(quaternion);
      // A refresh is not an arrival, so doorways stay live.
      this.arrivedAt = 0;
      return;
    }

    // Otherwise only what is lying on the floor can have changed.
    this.replaceObjects(snapshot);
    this.applyLighting(snapshot, styleFor(
      snapshot.room.number,
      snapshot.room.name,
      snapshot.room.selfLit,
    ));
  }

  /**
   * A compact description of the room's exits.
   *
   * Two snapshots with the same signature produce identical geometry, so the
   * shell can be reused. Passability is in it because an exit opening changes
   * whether a barrier is drawn across it.
   */
  private exitSignature(snapshot: WorldSnapshot): string {
    return snapshot.exits
      .map((exit) => {
        const passable =
          exit.kind === 'plain' || exit.kind === 'computed'
            ? true
            : exit.kind === 'blocked'
              ? false
              : exit.passable;
        return `${exit.direction}:${exit.kind}:${passable ? 1 : 0}`;
      })
      .join('|');
  }

  /** Swap the object layer without touching the room around it. */
  private replaceObjects(snapshot: WorldSnapshot): void {
    if (!this.roomGroup) return;

    if (this.objectLayer) {
      this.roomGroup.remove(this.objectLayer);
      this.objectLayer.traverse((node) => {
        if (node instanceof THREE.Mesh) node.geometry.dispose();
      });
    }

    const style = styleFor(snapshot.room.number, snapshot.room.name, snapshot.room.selfLit);
    const { group, targets } = placeObjects(snapshot.contents, this.materials, {
      width: style.width,
      depth: style.depth,
    });
    group.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    this.roomGroup.add(group);
    this.objectLayer = group;
    this.interactables = targets;
  }

  private placeCamera(built: BuiltRoom, style: RoomStyle, cameFrom: Direction | null): void {
    const position = new THREE.Vector3(0, EYE_HEIGHT, 0);

    if (cameFrom) {
      // Stand just inside the doorway opposite the way we travelled.
      const entry = built.doorways.find((d) => d.direction === OPPOSITE[cameFrom]);
      if (entry && !entry.vertical) {
        position.copy(entry.position);
        position.y = EYE_HEIGHT;
        position.addScaledVector(entry.facing, -1.6);
      }
    }

    // Never start inside a wall in a room too small for the offset above.
    position.x = THREE.MathUtils.clamp(position.x, -built.bounds.halfWidth, built.bounds.halfWidth);
    position.z = THREE.MathUtils.clamp(position.z, -built.bounds.halfDepth, built.bounds.halfDepth);
    this.controls.object.position.copy(position);

    // Face the way the player was travelling, so a corridor stays continuous.
    //
    // PointerLockControls reads yaw and pitch back off the camera's own
    // quaternion on every mouse move, so `lookAt` is all that is needed and
    // nothing must touch the rotation afterwards — zeroing it here, which an
    // earlier version did, left the player staring at the north wall of every
    // room they entered.
    // With a compass direction, keep facing the way we were travelling. Without
    // one — arriving through a window, up a rope, out of a trap door — face a
    // way out instead, because the alternative is being dropped in front of a
    // blank wall with no clue which way the room continues.
    const wayOut = built.doorways.find((doorway) => !doorway.vertical && doorway.passable);
    const heading = cameFrom
      ? TRAVEL_VECTOR[cameFrom]
      : wayOut
        ? wayOut.position.clone().setY(EYE_HEIGHT).sub(position).setY(0).normalize()
        : null;
    const target = heading
      ? position.clone().add(heading)
      : new THREE.Vector3(0, EYE_HEIGHT, 0);
    // Looking at the exact centre from the centre would be a zero-length
    // direction, so fall back to due north.
    if (target.distanceToSquared(position) < 1e-4) target.set(position.x, EYE_HEIGHT, position.z - 1);
    target.y = EYE_HEIGHT;
    this.camera.lookAt(target);

    void style;
  }

  private applyLighting(snapshot: WorldSnapshot, style: RoomStyle): void {
    const outdoors = style.ceiling === null;

    if (!snapshot.lit) {
      // Pitch black. Not quite zero, because a completely black frame reads as
      // a broken renderer rather than as darkness — this is just enough to
      // suggest a shape without showing anything useful.
      this.ambient.color.set('#0a0d14');
      this.ambient.intensity = 0.06;
      this.hemisphere.intensity = 0;
      this.sun.intensity = 0;
      this.roomLight.intensity = 0;
      this.lantern.intensity = 0;
      this.dustVisible(false);
      // Nothing is lit, so nothing should bloom.
      this.bloom.strength = 0;
      this.scene.fog = new THREE.FogExp2(0x000000, 0.42);
      this.scene.background = new THREE.Color(0x000000);
      return;
    }

    this.ambient.color.set(style.ambientColor);
    // Ambient is fill, not illumination: the multiplier brings the authored
    // 0..1 values into the range physical units actually need.
    this.ambient.intensity = style.ambient * 2.6;

    // A room that lights itself gets a source of its own, hung near the
    // ceiling so that surfaces are shaded rather than uniformly washed.
    const selfLitIndoors = snapshot.room.selfLit && !outdoors;
    this.roomLight.intensity = selfLitIndoors ? 14 + style.width * style.depth * 0.09 : 0;
    if (selfLitIndoors) {
      this.roomLight.color.set(style.ambientColor);
      this.roomLight.position.set(0, style.height * 0.86, 0);
      this.roomLight.distance = Math.max(style.width, style.depth) * 2.4;
    }

    // Outdoors needs three lights doing different jobs: a hemisphere for the
    // bounce off ground and sky, and a low sun for the long shadows that give
    // the trees and the house any form at all. Underground there is only the
    // lantern, which is the entire point of the lantern.
    this.hemisphere.intensity = outdoors ? 1.15 : 0;
    this.sun.intensity = outdoors ? 1.5 : 0;
    if (outdoors) {
      this.hemisphere.color.set(style.ambientColor);
      this.hemisphere.groundColor.set(style.floorTint);
      this.sun.color.set('#f4e8d0');
      // Placed on the camera's side of the room, and high. Lighting from
      // behind the scenery left every face the player looks at in shadow —
      // the white house came out the colour of the trees.
      this.sun.position.set(-13, 20, 15);
      this.sun.target.position.set(0, 0, -4);
      this.sun.target.updateMatrixWorld();
    }

    // The lantern only burns if something the player is carrying is lit. A
    // self-lit room is bright on its own and needs no help.
    const carryingLight = snapshot.inventory.some(
      (item) => item.providesLight || item.contents.some((c) => c.providesLight),
    );

    // Decay near inverse-square, which is what stops a nearby wall reading as
    // a flat blown-out patch of colour. The earlier near-linear falloff lit
    // the far side of a room but destroyed everything within two metres; the
    // fill below is what now carries the distance instead.
    this.lantern.decay = 1.5;
    this.lantern.intensity = carryingLight ? 15 : 0;
    this.lantern.distance = carryingLight ? 28 : 0;

    // Two-tone fill. The lantern is warm, so the fill is deliberately cold:
    // separating the two gives rock a shadow side that is blue rather than
    // merely darker, which is most of what stops a cave looking like brown
    // soup.
    if (carryingLight && style.ambient < 0.1) {
      this.ambient.color.set('#3a5474');
      this.ambient.intensity = 0.75;
    }

    // Dust only where there is a beam for it to hang in.
    this.dustVisible(carryingLight && !outdoors);

    // Bloom is turned down outdoors, where daylight is broad and an overcast
    // sky should not glow, and up underground where a single flame should.
    this.bloom.strength = outdoors ? 0.22 : 0.75;
    this.bloom.threshold = outdoors ? 0.85 : 0.62;

    this.scene.fog = new THREE.FogExp2(new THREE.Color(style.fogColor).getHex(), style.fogDensity);

    if (outdoors) {
      // The gradient's lower stop is the fog colour, so the ground haze and
      // the sky meet at the horizon instead of leaving a visible seam.
      const key = `${style.ambientColor}:${style.fogColor}`;
      let sky = this.skies.get(key);
      if (!sky) {
        sky = skyTexture(style.ambientColor, style.fogColor);
        this.skies.set(key, sky);
      }
      this.scene.background = sky;
    } else {
      this.scene.background = new THREE.Color(style.fogColor);
    }
  }

  private dustVisible(visible: boolean): void {
    if (this.dust) this.dust.points.visible = visible;
  }

  private teardownRoom(): void {
    if (!this.roomGroup) return;
    this.scene.remove(this.roomGroup);

    // Geometries are per-room and must be released; materials are shared and
    // owned by the library, so they are deliberately left alone.
    this.roomGroup.traverse((node) => {
      if (node instanceof THREE.Mesh) node.geometry.dispose();
    });

    this.roomGroup = null;
    this.objectLayer = null;
    this.built = null;
    this.interactables = [];
  }

  // ---------------------------------------------------------------- interaction

  private handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    this.pressed.add(event.code);

    if (event.code === 'KeyE') this.interactWithFocus();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /**
   * Look around by dragging, for when the pointer cannot be locked.
   *
   * Pointer lock needs permission the page does not always have — an iframe
   * without `allow="pointer-lock"` simply refuses, and the request rejects
   * silently. Rather than leave the player unable to turn their head, holding
   * the left button and dragging rotates the camera exactly as mouse-look
   * would. A press that ends without travelling counts as a click instead, so
   * one button does both jobs without a mode to remember.
   */
  private applyLook(deltaX: number, deltaY: number): void {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(this.camera.quaternion);
    euler.y -= deltaX * LOOK_SENSITIVITY;
    euler.x -= deltaY * LOOK_SENSITIVITY;
    // Stop just short of straight up and down; going past would flip the roll.
    euler.x = THREE.MathUtils.clamp(euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.camera.quaternion.setFromEuler(euler);
  }

  private handleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;

    // With the pointer locked there is no drag to track: a click is a click.
    if (this.controls.isLocked) {
      this.interactWithFocus();
      return;
    }

    this.dragging = { x: event.clientX, y: event.clientY, travelled: 0 };
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.dragging || this.controls.isLocked) return;

    const deltaX = event.clientX - this.dragging.x;
    const deltaY = event.clientY - this.dragging.y;
    this.dragging.travelled += Math.abs(deltaX) + Math.abs(deltaY);
    this.dragging.x = event.clientX;
    this.dragging.y = event.clientY;

    this.applyLook(deltaX, deltaY);
  };

  private handleMouseUp = (): void => {
    const drag = this.dragging;
    this.dragging = null;
    // A press that barely moved was someone pointing at something, not turning.
    if (drag && drag.travelled < 6) this.interactWithFocus();
  };

  /** The object under the reticle, if any. */
  private pickFocus(): THREE.Object3D | null {
    if (this.interactables.length === 0) return null;

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 6;
    const hits = this.raycaster.intersectObjects(this.interactables, true);
    const hit = hits[0];
    if (!hit) return null;

    // Walk up to the group that carries the object number.
    let node: THREE.Object3D | null = hit.object;
    while (node && node.userData['objectNumber'] === undefined) node = node.parent;
    return node;
  }

  private interactWithFocus(): void {
    const node = this.pickFocus();
    if (!node) return;
    this.callbacks.onInteract(
      node.userData['objectNumber'] as number,
      node.userData['objectName'] as string,
    );
  }

  /** Check whether the player has walked into a doorway. */
  private checkDoorways(): void {
    if (!this.built || this.movementLocked) return;
    if (performance.now() - this.arrivedAt < ARRIVAL_GRACE_MS) return;

    const position = this.controls.object.position;

    for (const doorway of this.built.doorways) {
      if (doorway.vertical) {
        // A hole in the floor is entered by standing over it. A way up needs
        // the interact key, since walking cannot take you there.
        if (doorway.direction !== 'down') continue;
        const distance = Math.hypot(
          position.x - doorway.position.x,
          position.z - doorway.position.z,
        );
        if (distance < 1.0 && doorway.passable) {
          this.callbacks.onMove(doorway.direction);
          this.arrivedAt = performance.now();
          return;
        }
        continue;
      }

      const distance = Math.hypot(
        position.x - doorway.position.x,
        position.z - doorway.position.z,
      );
      if (distance > DOORWAY_TRIGGER) continue;

      // Only trigger when actually heading outward, so brushing past a doorway
      // along a wall does not fling the player through it.
      const heading = new THREE.Vector3();
      this.camera.getWorldDirection(heading);
      if (heading.dot(doorway.facing) < 0.25) continue;

      if (!doorway.passable) {
        // Still send it: the game's refusal is the correct thing for the
        // player to read, and it is what the original would have said.
        this.callbacks.onMove(doorway.direction);
        this.arrivedAt = performance.now();
        return;
      }

      this.callbacks.onMove(doorway.direction);
      this.arrivedAt = performance.now();
      return;
    }
  }

  private updateMovement(delta: number): void {
    // Deliberately not gated on pointer lock: where lock is unavailable the
    // player still needs to walk. Typing is the only thing that suspends
    // movement, and the key handler already ignores events from the prompt.
    if (!this.built || this.typing) return;

    const forward = Number(this.pressed.has('KeyW')) - Number(this.pressed.has('KeyS'));
    const strafe = Number(this.pressed.has('KeyD')) - Number(this.pressed.has('KeyA'));
    if (forward === 0 && strafe === 0) return;

    const speed = WALK_SPEED * delta * (this.pressed.has('ShiftLeft') ? 1.7 : 1);
    // moveForward/moveRight keep motion in the horizontal plane even when the
    // camera is pitched up or down, which is what stops looking at the ceiling
    // from lifting the player off the floor.
    this.controls.moveForward(forward * speed);
    this.controls.moveRight(strafe * speed);

    const position = this.controls.object.position;
    position.x = THREE.MathUtils.clamp(
      position.x,
      -this.built.bounds.halfWidth,
      this.built.bounds.halfWidth,
    );
    position.z = THREE.MathUtils.clamp(
      position.z,
      -this.built.bounds.halfDepth,
      this.built.bounds.halfDepth,
    );
    position.y = EYE_HEIGHT;
  }

  private updateFocusLabel(): void {
    const node = this.pickFocus();
    const label = node ? ((node.userData['objectName'] as string) ?? null) : null;
    if (label !== this.focused) {
      this.focused = label;
      this.callbacks.onFocus(label);
    }
  }

  /** Drive one frame. */
  start(): void {
    const frame = (): void => {
      requestAnimationFrame(frame);
      const delta = Math.min(this.clock.getDelta(), 0.1);

      this.updateMovement(delta);
      this.checkDoorways();
      this.updateFocusLabel();

      this.dust?.update(delta, this.camera);
      this.composer.render();
    };
    frame();
  }

  /** Direction of the last move, used to place the camera on arrival. */
  rememberDirection(direction: Direction | null): void {
    this.lastDirection = direction;
  }

  get travelDirection(): Direction | null {
    return this.lastDirection;
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.canvas.removeEventListener('mousedown', this.handleClick);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.teardownRoom();
    this.dust?.dispose();
    for (const sky of this.skies.values()) sky.dispose();
    this.skies.clear();
    this.materials.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
