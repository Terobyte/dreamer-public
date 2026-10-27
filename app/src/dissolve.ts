import { dyno, type SplatMesh } from '@sparkjsdev/spark';

const { add, sub, mul, smoothstep, hashFloat, hashVec3, splitGsplat, combineGsplat, dynoConst, dynoFloat } = dyno;

// H8: dream dissolve. t = 0 is the assembled object, t = 1 is drifting dust.
// Each splat starts at its own random moment, flies off along a random direction and up,
// shrinks and fades. Runs in object space, where SAM3D objects are a unit box with Z up.
export function dissolveModifier() {
  const t = dynoFloat(0);
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const s = splitGsplat(gsplat!).outputs;
    const start = mul(hashFloat(s.index), dynoConst('float', 0.6));
    const p = smoothstep(start, add(start, dynoConst('float', 0.4)), t);
    const dir = sub(mul(hashVec3(add(s.index, dynoConst('int', 7919))), dynoConst('float', 2)), dynoConst('vec3', [1, 1, 1]));
    const drift = add(mul(dir, dynoConst('float', 0.6)), dynoConst('vec3', [0, 0, 0.8]));
    const keep = sub(dynoConst('float', 1), p);
    return {
      gsplat: combineGsplat({
        gsplat: gsplat!,
        center: add(s.center, mul(drift, p)),
        scales: mul(s.scales, add(dynoConst('float', 0.5), mul(keep, dynoConst('float', 0.5)))),
        opacity: mul(s.opacity, keep),
      }),
    };
  });
  return { t, modifier };
}

export type Dissolvable = { mesh: SplatMesh; t: ReturnType<typeof dynoFloat>; target: number };
