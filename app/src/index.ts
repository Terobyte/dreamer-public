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
import { hostEngineWorld } from './engine-host.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // ?world=<name>: an engine-built world from public/worlds/<name>/ (XR spike)
  // the managed dev browser resets the URL to `/`, so localStorage is the spike's fallback
  const engineWorld =
    new URLSearchParams(location.search).get('world') ?? localStorage.getItem('xrspike.world');
  if (engineWorld) {
    hostEngineWorld(world, `./worlds/${engineWorld}/`).catch((e) => console.error('engine world failed', e));
    return;
  }
  world.registerSystem(SplatStatsSystem);
  world.registerSystem(DissolveSystem);
  addFloor(world).catch((e) => console.error('floor failed', e));
  addSplats(world);
});
