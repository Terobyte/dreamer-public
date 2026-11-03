"""Plan-view (x, z) geometry for room footprints. Pure, no dependencies."""

import math

EPS = 1e-6

#: max straight-segment length when flattening a bulged edge (engine spec)
_ARC_STEP = 0.25


def _bulge_of(vertex):
    """Bulge annotated on an edge's start vertex; 0 for straight edges."""
    if len(vertex) == 3 and isinstance(vertex[2], dict):
        b = vertex[2].get("bulge", 0)
        if isinstance(b, (int, float)) and not isinstance(b, bool):
            return float(b)
    return 0.0


def _arc_points(a, b, bulge, sign):
    """Interior points flattening one bulged edge from a to b (excluded).

    Same circular arc as the engine: `bulge` is sagitta / half-chord,
    positive = outward from the chord polygon; the outward normal follows
    the polygon winding. See engine `arcOf` in `schema/validate.ts`.
    """
    cx, cz = b[0] - a[0], b[1] - a[1]
    c = math.hypot(cx, cz)
    half = c / 2.0
    sag = bulge * half
    R = (half * half + sag * sag) / (2.0 * sag)
    radius = abs(R)
    ux, uz = sign * cz / c, -sign * cx / c
    mx, mz = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
    ox, oz = mx + ux * (sag - R), mz + uz * (sag - R)

    def ang(q):
        return math.atan2(q[1] - oz, q[0] - ox)

    wrap = lambda v: (v % (2.0 * math.pi) + 2.0 * math.pi) % (2.0 * math.pi)
    a0 = ang(a)
    span = wrap(ang(b) - a0)
    apex = (mx + ux * sag, mz + uz * sag)
    sweep = span if wrap(ang(apex) - a0) <= span else span - 2.0 * math.pi
    n = max(1, int(math.ceil(radius * abs(sweep) / _ARC_STEP)))
    return [
        (ox + radius * math.cos(a0 + sweep * i / n),
         oz + radius * math.sin(a0 + sweep * i / n))
        for i in range(1, n)
    ]


def _footprint(room):
    """Closed ring of the room footprint with bulged edges flattened."""
    shape = room.get("shape") or []
    pts = [(float(v[0]), float(v[1])) for v in shape]
    if len(pts) < 3:
        return []
    area2 = sum(ax * bz - bx * az for (ax, az), (bx, bz) in zip(pts, pts[1:] + pts[:1]))
    sign = 1.0 if area2 >= 0.0 else -1.0
    ring = []
    for i, v in enumerate(shape):
        a = pts[i]
        b = pts[(i + 1) % len(pts)]
        ring.append(a)
        bulge = _bulge_of(v)
        if bulge != 0.0 and (a[0] != b[0] or a[1] != b[1]):
            ring.extend(_arc_points(a, b, bulge, sign))
    return ring


def _on_segment(px, pz, ax, az, bx, bz):
    cross = (bx - ax) * (pz - az) - (bz - az) * (px - ax)
    if abs(cross) > EPS * max(1.0, abs(bx - ax) + abs(bz - az)):
        return False
    return (
        min(ax, bx) - EPS <= px <= max(ax, bx) + EPS
        and min(az, bz) - EPS <= pz <= max(az, bz) + EPS
    )


def in_room(room, x, z):
    """True if (x, z) is inside the room footprint; the boundary counts as inside."""
    circle = room.get("circle")
    if circle:
        cx, cz = float(circle["c"][0]), float(circle["c"][1])
        r = float(circle["r"])
        return (x - cx) ** 2 + (z - cz) ** 2 <= (r + EPS) ** 2

    ring = _footprint(room)
    if len(ring) < 3:
        return False

    for i, (ax, az) in enumerate(ring):
        bx, bz = ring[(i + 1) % len(ring)]
        if _on_segment(x, z, ax, az, bx, bz):
            return True

    inside = False
    for i, (ax, az) in enumerate(ring):
        bx, bz = ring[(i + 1) % len(ring)]
        if (az > z) != (bz > z):
            cut = ax + (z - az) * (bx - ax) / (bz - az)
            if x < cut:
                inside = not inside
    return inside
