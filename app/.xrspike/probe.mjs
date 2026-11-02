export default async function run({ frame: page }) {
  await page.waitForFunction(() => window.__xrspike?.ready === true, null, { timeout: 45000 }).catch(() => {});
  return await page.evaluate(() => {
    const w = window.__xrworld;
    if (!w) return { world: null, ls: localStorage.getItem('xrspike.world') };
    const v = (o) => { const p = new w.camera.position.constructor(); o.getWorldPosition(p); return [p.x, p.y, p.z].map((n) => +n.toFixed(2)); };
    const g = w.scene.getObjectByName('EngineWorld');
    return {
      report: window.__xrspike,
      player: v(w.player), camera: v(w.camera), playerRotY: +w.player.rotation.y.toFixed(2),
      engineInScene: !!g, engineParent: g?.parent?.type, engineChildren: g?.children.length,
      bg: w.scene.background?.isColor ? 'color' : String(w.scene.background?.constructor?.name),
      xr: w.renderer.xr.isPresenting,
    };
  });
}
