/**
 * three@0.185.0 ships no type declarations and `@types/three` is not one of
 * this engine's dependencies, so the slice of the library the runtime uses
 * is declared here.
 */
declare module "three" {
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }
  export class Color {
    constructor(value?: string | number);
  }
  export class Object3D {
    name: string;
    visible: boolean;
    position: Vector3;
    up: Vector3;
    userData: Record<string, unknown>;
    add(...o: Object3D[]): this;
    lookAt(x: number, y: number, z: number): void;
    updateMatrixWorld(force?: boolean): void;
    getWorldDirection(target: Vector3): Vector3;
  }
  export class Scene extends Object3D {
    background: Color | null;
  }
  export class Group extends Object3D {}
  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this;
    setIndex(index: BufferAttribute): this;
  }
  export class Texture {}
  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement);
  }
  export class Material {
    transparent: boolean;
    userData: Record<string, unknown>;
  }
  export class MeshStandardMaterial extends Material {
    constructor(params?: Record<string, unknown>);
    map: Texture | null;
  }
  export class Mesh extends Object3D {
    constructor(geometry: BufferGeometry, material: Material);
    material: Material;
  }
  export class Light extends Object3D {}
  export class AmbientLight extends Light {
    constructor(color?: string | number, intensity?: number);
  }
  export class HemisphereLight extends Light {
    constructor(sky?: Color | string | number, ground?: Color | string | number, intensity?: number);
  }
  export class PointLight extends Light {
    constructor(color?: Color | string | number, intensity?: number);
  }
  export class Camera extends Object3D {}
  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    isPerspectiveCamera: boolean;
    updateProjectionMatrix(): void;
  }
  export class OrthographicCamera extends Camera {
    constructor(left: number, right: number, top: number, bottom: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
  }
  export class WebGLRenderer {
    constructor(params?: Record<string, unknown>);
    domElement: HTMLCanvasElement;
    getContext(): unknown;
    setPixelRatio(value: number): void;
    setSize(w: number, h: number): void;
    render(scene: Scene, camera: Camera): void;
  }
  export const DoubleSide: number;
}
