import math

def edge_outward_normal_xz(p0, p1):
    # edge direction
    dx = p1[0] - p0[0]
    dz = p1[1] - p0[1]

    # outward normal (CCW polygon)
    nx = dz
    nz = -dx

    length = math.hypot(nx, nz)
    if length == 0:
        return None

    return (nx / length, nz / length)

def make_offset_halfplane(p0, p1, offset):
    n = edge_outward_normal_xz(p0, p1)
    if n is None:
        return None

    nx, nz = n
    c = nx * p0[0] + nz * p0[1] + offset
    return (nx, nz, c)

def intersect_lines_2d(l1, l2):
    n1x, n1z, c1 = l1
    n2x, n2z, c2 = l2

    det = n1x * n2z - n1z * n2x
    if abs(det) < 1e-6:
        return None

    x = (c1 * n2z - n1z * c2) / det
    z = (n1x * c2 - c1 * n2x) / det
    return (x, z)

def inside_all_halfplanes(p, planes):
    x, z = p
    for nx, nz, c in planes:
        if nx * x + nz * z < c - 1e-6:
            return False
    return True

def expanded_triangle_xz(v0, v1, v2, offset=1.0):
    # XZ only
    p0 = (v0[0], v0[2])
    p1 = (v1[0], v1[2])
    p2 = (v2[0], v2[2])

    # build offset half-planes
    planes = []
    planes.append(make_offset_halfplane(p0, p1, offset))
    planes.append(make_offset_halfplane(p1, p2, offset))
    planes.append(make_offset_halfplane(p2, p0, offset))

    if any(p is None for p in planes):
        return None

    # candidate points = intersections of plane pairs
    candidates = []
    for i in range(3):
        for j in range(i + 1, 3):
            p = intersect_lines_2d(planes[i], planes[j])
            if p and inside_all_halfplanes(p, planes):
                candidates.append(p)

    # deduplicate
    unique = []
    for p in candidates:
        if not any(abs(p[0] - q[0]) < 1e-5 and abs(p[1] - q[1]) < 1e-5 for q in unique):
            unique.append(p)

    if len(unique) < 3:
        return None

    return unique  # 3–6 points

def plane_y_at_xz(nx, ny, nz, d, x, z):
    return ((-nx * x) - (nz * z) - d) / ny

def standable_poly_from_tri_bug(tri_flat, offset=1.0):
    (
        x0, y0, z0,
        x1, y1, z1,
        x2, y2, z2,
        nx_i, ny_i, nz_i,
        d
    ) = tri_flat

    COLPOLY_NORMAL_FRAC = 1.0 / 32767.0
    nx = nx_i * COLPOLY_NORMAL_FRAC
    ny = ny_i * COLPOLY_NORMAL_FRAC
    nz = nz_i * COLPOLY_NORMAL_FRAC

    if ny <= 0:
        return None  # not standable

    xz_poly = expanded_triangle_xz(
        (x0, y0, z0),
        (x1, y1, z1),
        (x2, y2, z2),
        offset
    )

    if not xz_poly:
        return None

    result = []
    for x, z in xz_poly:
        y = plane_y_at_xz(nx, ny, nz, d, x, z)
        result.append((x, y, z))

    return result

def format_poly(points):
    parts = [f"poly {len(points)}"]
    for x, y, z in points:
        parts.append(f"{x:.7f} {y:.7f} {z:.7f}")
    return " ".join(parts)
    
def export_standable_polys(
    input_path,
    output_path,
    y_target,
    y_range
):
    out_lines = []

    with open(input_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            tri = tuple(float(x) for x in line.split(","))

            poly = standable_poly_from_tri_bug(
                tri
            )

            if poly:
                out_lines.append(format_poly(poly))

    with open(output_path, "w") as f:
        f.write("\n".join(out_lines))

export_standable_polys(
    input_path="tris.txt",
    output_path="standable_polys.txt",
    y_target=-380.0,
    y_range=5.0
)
      