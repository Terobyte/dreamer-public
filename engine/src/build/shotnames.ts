/**
 * The contract is `shots/<camera id>.png`, so an id that is already a legal
 * filename is kept verbatim (`front:view` -> `front:view.png`); only what
 * would make the name point somewhere else is replaced: path separators,
 * control characters, and the two names that mean a directory (`.`, `..`).
 * Distinct ids can sanitize to the same string (e.g. `room/left` and
 * `room_left`), so a colliding base gets its index appended; that suffixed
 * name is itself checked against every name already assigned (including
 * another camera's literal id, e.g. `room_left-0`), and grows a further
 * `-<index>` suffix until it is unique. An id with no collision at all keeps
 * its plain name.
 */
export function shotBaseNames(cameras: { id: string }[]): string[] {
  const base = cameras.map((c) => {
    const safe = c.id.replace(/[/\\\x00-\x1f]/g, "_");
    return safe === "" || safe === "." || safe === ".." ? `_${safe}` : safe;
  });
  const counts = new Map<string, number>();
  // APFS and NTFS fold case: `A.png` and `a.png` are one file
  const fold = (s: string): string => s.toLowerCase();
  for (const b of base) counts.set(fold(b), (counts.get(fold(b)) ?? 0) + 1);
  const used = new Set<string>();
  return base.map((b, i) => {
    let name = (counts.get(fold(b)) ?? 0) > 1 ? `${b}-${i}` : b;
    while (used.has(fold(name))) name = `${name}-${i}`;
    used.add(fold(name));
    return name;
  });
}
