import {
  AssetManager,
  CanvasTexture,
  CircleGeometry,
  LocomotionEnvironment,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type World,
} from '@iwsdk/core';

// Sand disc under Conch Street. Its edge fades out radially so it melts into the sky
// panorama's painted ground instead of ending in a visible rim.
const FLOOR_RADIUS = 40;
const TILE_METERS = 3;

export async function addFloor(world: World) {
  const sand = (await AssetManager.loadTextureById('floor-sand')).clone();
  sand.colorSpace = SRGBColorSpace;
  sand.wrapS = sand.wrapT = RepeatWrapping;
  sand.repeat.setScalar((FLOOR_RADIUS * 2) / TILE_METERS);
  sand.anisotropy = world.renderer.capabilities.getMaxAnisotropy();
  sand.needsUpdate = true;

  const fade = document.createElement('canvas');
  fade.width = fade.height = 256;
  const g = fade.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 64, 128, 128, 128);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(1, '#000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);

  const floor = new Mesh(
    new CircleGeometry(FLOOR_RADIUS, 96),
    new MeshBasicMaterial({ map: sand, alphaMap: new CanvasTexture(fade), transparent: true }),
  );
  floor.name = 'SandFloor';
  floor.rotation.x = -Math.PI / 2;
  // drawn before the splats so it hides any splat dust below ground level
  floor.renderOrder = -1;
  world.createTransformEntity(floor).addComponent(LocomotionEnvironment);
}
