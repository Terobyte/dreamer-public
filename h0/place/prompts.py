"""The two Spark steps of a real place: look at the photos (read), then lay the place out on the satellite (plan)."""

READ = """You are the eyes of a 3D world builder. You get labelled Street View frames of ONE real courtyard.
Look, do not remember: write only what the frames show. Your notes feed three workers:
- code builds the space (walls, floors, kerbs) in metres;
- an image model paints flat seamless textures and flat facade pictures;
- a 3D model makes each solid object from ONE frame by cutting it out with a short noun phrase.

Return ONE JSON object, no prose:
{
 "season": "one line: season, foliage, light, sky",
 "sky_prompt": "what is on the sky and on the horizon, no people",
 "house": {
   "floors": int, "floor_h": metres per storey, "plinth_h": metres of the painted base,
   "wall_tile": "seamless texture prompt of the bare wall material (brick colour, joints)",
   "plinth_tile": "seamless texture prompt of the plinth paint",
   "bay": "prompt for ONE facade bay picture: one storey high, one window wide, straight-on, what the window, frame, balcony slab, parapet, glazing look like; it is repeated along the wall",
   "bay_plain": "same bay without a balcony (ground floor)",
   "door": "prompt for the entrance door picture, straight-on, filling the frame",
   "entrances": int seen along the long yard wall
 },
 "buildings": [{"hint": "where it is seen (frame names)", "floors": int, "facade": "prompt for one bay picture of that building"}],
 "ground": {"drive": "seamless texture prompt of the drive surface", "lawn": "seamless prompt of the ground inside the yard (earth, leaves, grass)",
            "court": "seamless prompt of the sports court surface", "kerb": "seamless prompt of the kerb stone"},
 "objects": [{"id": "snake_case", "what": "short noun phrase to cut it out of that frame (3-6 words, the object only)",
              "frame": "exact frame file name where it is biggest and least hidden", "height_m": number,
              "count": int how many alike in the yard, "seen": "where it stands, in words"}],
 "canopy": {"what": "noun phrase for the entrance canopy", "frame": "frame file name", "height_m": number},
 "trees": [{"id": "snake_case", "what": "noun phrase for one tree", "frame": "frame file name", "height_m": number, "share": 0..1}]
}
Objects: every distinct solid thing a visitor would remember (play tower, slide, swings, climbing frame, benches, table,
basketball hoop, bins, fences...), 6 to 14 kinds. Not cars, not people."""

PLAN = """You lay out a real courtyard for a 3D engine. The picture is the satellite seen in the YARD FRAME:
s = metres along the long yard wall of the main house (left to right), n = metres out from that wall into the yard (up).
The grid is labelled every 10 m; red outlines are OSM building footprints (the main house wall is the line n = 0).
You also get the visual notes of the yard (from Street View) and some of the frames.

Read positions off the satellite and the frames. Do not invent a generic yard. Return ONE JSON object:
{
 "yard": [s0, s1, n0, n1],            // the walkable courtyard box in the frame (stay out of other footprints)
 "zones": [{"id": "snake_case", "floor": "drive|lawn|court", "rect": [s0, s1, n0, n1]}],   // asphalt drives, lawns, the court; later zones paint over earlier ones; the yard box is lawn by default
 "kerbs": [[s0, n0, s1, n1]],         // kerb lines (edges of drives / island), metres
 "entrances": [s, ...],               // entrance doors along the main wall (n = 0)
 "props": [{"id": "object id from the notes", "s": num, "n": num, "yaw": degrees (0 = its front faces the main wall, 90 = faces +s), "h": metres, "w": footprint width m, "d": footprint depth m}],
 "trees": [{"id": "tree id from the notes", "s": num, "n": num, "h": metres}],
 "fences": [{"from": [s, n], "to": [s, n], "h": metres, "kind": "pipe|rod|concrete"}],
 "spawn": {"s": num, "n": num, "look": [s, n]},        // a visitor's first standpoint, clear of props
 "shop_site": {"s0": num, "s1": num, "why": "a free stretch of the main wall's ground floor where a small shop could open"}
}
Rules: props at least 1 m apart and never inside a drive; trees where the satellite shows crowns (25 to 60 trees), not on drives,
the court or props; entrances where the frames show canopies; all numbers in metres in this frame."""
