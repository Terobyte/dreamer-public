/** types for the XR checker the engine tests run (runtime-world.test.ts) */
export default function run(o: { page: any; frame?: any }): Promise<number>;
export function maxGap(samples: number[]): number;
