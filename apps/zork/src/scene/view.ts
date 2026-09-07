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
import type { Direction, Exit, ObjectView, WorldSnapshot } from '@deuce/zmachine';

import { MaterialLibrary } from './materials.js';
import { buildRoom, EYE_HEIGHT, type BuiltRoom } from './room.js';
import { buildSetDressing, placeObjects } from './props.js';
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

  /** Everything belonging to the current room, torn down on every change. */
  private roomGroup: THREE.Group | null = null;
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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Zork lives at the bottom of the exposure range, so a filmic curve keeps
    // the lantern's falloff from clipping to flat black.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;

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
    this.camera.add(this.lantern);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.ambient, this.hemisphere, this.sun, this.roomLight);

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
    group.add(
      buildSetDressing(style.props, this.materials, {
        width: style.width,
        depth: style.depth,
        height: style.height,
        seed: style.seed,
        // Outdoors the treeline stands in for walls, so it needs to know
        // which bearings are ways out and must be left clear.
        clearBearings: built.doorways
          .filter((doorway) => !doorway.vertical)
          .map((doorway) => Math.atan2(doorway.position.z, doorway.position.x)),
      }),
    );

    // Scenery the room declares is drawn but not made clickable — the white
    // house and the staircase are things to look at, and the game answers for
    // them through the parser if the player asks.
    const visible: ObjectView[] = snapshot.contents;
    const { group: objectGroup, targets } = placeObjects(visible, this.materials, {
      width: style.width,
      depth: style.depth,
    });
    group.add(objectGroup);

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
    const position = this.controls.object.position.clone();
    const quaternion = this.camera.quaternion.clone();

    this.setRoom(snapshot, null);

    this.controls.object.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    // A refresh is not an arrival, so doorways stay live.
    this.arrivedAt = 0;
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
      this.sun.color.set('#f0e4cc');
      this.sun.position.set(-14, 22, -10);
    }

    // The lantern only burns if something the player is carrying is lit. A
    // self-lit room is bright on its own and needs no help.
    const carryingLight = snapshot.inventory.some(
      (item) => item.providesLight || item.contents.some((c) => c.providesLight),
    );
    // Decay just above linear, rather than physically correct inverse-square:
    // a real flame at this intensity either blinds you at arm's length or dies
    // within two metres, and the room has to be legible at both.
    this.lantern.intensity = carryingLight ? 8 : 0;
    this.lantern.distance = carryingLight ? 26 : 0;

    // A trace of fill so that stone at the edge of the lantern's reach is dim
    // rather than absent. Without it a cave reads as a black void with a
    // spotlit disc in the middle of it.
    if (carryingLight && style.ambient < 0.1) {
      this.ambient.color.set('#2a3038');
      this.ambient.intensity = 0.22;
    }

    this.scene.fog = new THREE.FogExp2(new THREE.Color(style.fogColor).getHex(), style.fogDensity);
    this.scene.background = new THREE.Color(style.fogColor);
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
    this.built = null;
    this.interactables = [];
  }

  // ---------------------------------------------------------------- interaction

  private handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
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

      this.renderer.render(this.scene, this.camera);
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
    this.materials.dispose();
    this.renderer.dispose();
  }
}
