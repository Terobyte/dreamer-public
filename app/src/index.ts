/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { addFloor } from './env.js';
import { addSplats, DissolveSystem, SplatStatsSystem } from './splats.js';
import { hostEngineWorld, pickWorld } from './engine-host.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // engine-built world from public/worlds/<name>/ (?world= → localStorage → VITE_DREAMER_WORLD)
  const engineWorld = pickWorld();
  if (engineWorld) {
    void hostEngineWorld(world, `./worlds/${engineWorld}/`);
    return;
  }
  world.registerSystem(SplatStatsSystem);
  world.registerSystem(DissolveSystem);
  addFloor(world).catch((e) => console.error('floor failed', e));
  addSplats(world);
});
