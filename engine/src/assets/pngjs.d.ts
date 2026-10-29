// pngjs ships no types and the phase adds no dependencies, so the few
// members the engine uses are declared here, as `three.d.ts` does for three.
declare module "pngjs" {
  export class PNG {
    constructor(opts?: { width: number; height: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buf: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}
