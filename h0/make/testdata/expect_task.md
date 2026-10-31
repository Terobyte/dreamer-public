Build the whole interior of a small set of rooms (private test scene, never shipped):
all rooms walkable and connected by doors and stairs.

Floors and rooms (ids are suggestions, keep them without `_`):
- L0 ground floor
  - `hall` (about 5 x 4 m, room): next to `kitchen`.
  - `kitchen` (about 4 x 3 m, room): next to `hall`.
- L1 second floor
  - `attic` (about 6 x 5 m, room): no neighbours named.

Levels and stairs (the engine is strict here): floor-to-floor 3.0 m on every level (L0 y=0, L1 y=3).
A staircase cuts its stairwell only in the floor of the room it leads to, so its whole run must lie under that room's footprint.
Keep stairs straight and along a wall.

Style for every image prompt (tiles, decals, objects): warm gouache, flat painted colours.
Nobody lives in the scene: no people, animals or characters in any image. In asset prompts never write show, character or brand names: describe only what the object looks like (shape, colour, material).

Each room should be recognisable from its reference images (see cues.md and refs/ next to this file). A few large signature objects per room beat many small ones.
