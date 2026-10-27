/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

// Conch Street: the sky is a DomeTexture on the level root, the floor is built in env.ts,
// the splats are loaded by splats.ts. Only the floor texture goes through the manifest.
export default defineAssets({
  'floor-sand': {
    url: publicAssetUrl('env/floor_sand.png'),
    type: AssetType.Texture,
    name: 'Sand Floor',
  },
});
