import { Box3, CanvasTexture, Color, DirectionalLight, HemisphereLight, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { cutDarkTexels, loadGlb } from "../../src/runtime/assets.js";

/** The oak on a white backdrop, as PNG data, through the page's own loadGlb. */
(window as unknown as { shoot: (url: string) => Promise<string> }).shoot = async (url) => {
  const r = new WebGLRenderer({ preserveDrawingBuffer: true });
  r.setSize(512, 512);
  const scene = new Scene();
  scene.background = new Color(0xffffff);
  scene.add(new HemisphereLight(0xffffff, 0x888888, 2.5));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const box = { min: new Vector3(-1, 0, -1), max: new Vector3(1, 2, 1) };
  const root = await loadGlb({ glb: url }, box);
  scene.add(root);
  const b = new Box3().setFromObject(root);
  const c = b.getCenter(new Vector3());
  const s = b.getSize(new Vector3());
  const cam = new PerspectiveCamera(40, 1, 0.1, 1000);
  cam.position.set(c.x, c.y, c.z + Math.max(s.x, s.y) * 1.8);
  cam.lookAt(c);
  r.render(scene, cam);
  return r.domElement.toDataURL("image/png");
};

/** Runs the page's own cutDarkTexels over a real 2-texel canvas texture and
 * reports the resulting alphas [dark, light]. F8/F12: proves a real dark
 * texel of an ordinary (unmarked) prop stays opaque, with the marked
 * foliage case as the positive control. */
(window as unknown as { probeCutout: (marked: boolean) => number[] }).probeCutout = (marked) => {
  const src = document.createElement("canvas");
  src.width = 2;
  src.height = 1;
  const sctx = src.getContext("2d")!;
  sctx.fillStyle = "rgb(8,8,8)";
  sctx.fillRect(0, 0, 1, 1);
  sctx.fillStyle = "rgb(200,200,200)";
  sctx.fillRect(1, 0, 1, 1);
  const mat = new MeshStandardMaterial({ map: new CanvasTexture(src), alphaTest: 0.5 });
  if (marked) mat.userData["foliageCutout"] = true;
  cutDarkTexels({ traverse: (cb: (o: unknown) => void) => cb({ material: mat }) } as never);
  const out = document.createElement("canvas");
  out.width = 2;
  out.height = 1;
  const octx = out.getContext("2d")!;
  octx.drawImage(mat.map!.image as CanvasImageSource, 0, 0);
  const px = octx.getImageData(0, 0, 2, 1).data;
  return [px[3], px[7]];
};
