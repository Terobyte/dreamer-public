# Dreamer Home

One page for everything Dreamer can show: our ready scenes, played **as the book tells them** or in **freestyle** (the director and the characters improvise), and **Create**, where you write what happens next and Dreamer stages it in one of our worlds.

```sh
cd h0
python3 -m home            # http://localhost:8800/
python3 -m home --fake     # no network, no money: stub scenes, canned chapter, make --fake
```

## What is on the page

| Tab | What you get |
|---|---|
| **Book** | Koshakan (bedroom, bathroom, meadow) and Sherlock's 221B Baker Street. The scene plays as written; press **G** inside it to switch to freestyle. |
| **Freestyle** | The same scenes, already improvising, plus Kozbagarov St. 7: a real yard in Semey built from OpenStreetMap, satellite and Street View. There you hold Space and say what should open, and a shop grows into the house in about 2.5 minutes. Inside any freestyle scene, **Tab** opens a line for whispering the director an idea. |
| **Create** | Pick a world (Koshakan's house or 221B) and write or say your idea. Muse Spark writes a short chapter with that world's characters, `make` stages it in the ready world, and it appears under *Your scenes*, playable as a book or in freestyle. Measured on Nov 4: 3 min 04 s and $0.07 for "Mirai finds a tiny lost kitten in the meadow". |

## How it works

- `scenes.json` is the catalog: scenes (`run`, `modes`, `cover`) and worlds for Create (`dir`, `book`, `cast`, `who`). Paths are checked against `meta/`, `../anymove`, `../meta-place`; a scene whose files are missing is hidden.
- A scene is `python -m make.play <run> [--freestyle]`, or `python -m place.serve <run>` for the yard. It runs in its own process group on free ports. Home reads its page URL from stdout and frames it, and **← Home** stops the whole group.
- Create writes `runs/home-<ts>/`:
  1. `book/` holds the chapter (`write.py`, one Spark contributor call; the code checks room, cast and line format, with one retry);
  2. `cast.src/` is the world's ready cast;
  3. then it runs `python -m make "<idea>" --book … --scene custom --world <world> --max-dollars 1`.

  Progress comes from `make.json`.
- Requests that start processes or spend money are accepted only from this page: local Host, own Origin, JSON / WAV content type. Keys stay in the server's env.

## Tests

```sh
cd h0 && python3 -m unittest home.test_home   # 37 tests, part of tools/gate.sh
cd h0 && node home/e2e.mjs                    # Playwright against --fake, screenshots in h0/out/home/
```

The scenes' built worlds live outside this repo (`../anymove/runs/koshakan`, `../meta-place/runs/sherlock_221b_*`, `runs/yard-kozb7`), so a fresh clone runs `--fake` only.
