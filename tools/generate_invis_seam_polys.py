def plane_y(nx, ny, nz, d, x, z):
    return ((-nx * x) - (nz * z) - d) / ny
    
def clip_edge_y_band(v0, v1, nx, ny, nz, d, y_min, y_max):
    x0, z0 = v0[0], v0[2]
    x1, z1 = v1[0], v1[2]

    y0 = plane_y(nx, ny, nz, d, x0, z0)
    y1 = plane_y(nx, ny, nz, d, x1, z1)

    points = []

    # vertex inside band?
    if y_min <= y0 <= y_max:
        points.append((x0, y0, z0))

    dy = y1 - y0
    if abs(dy) < 1e-6:
        return points

    # intersections with band planes
    for y_plane in (y_min, y_max):
        t = (y_plane - y0) / dy
        if 0.0 < t < 1.0:
            x = x0 + t * (x1 - x0)
            z = z0 + t * (z1 - z0)
            y = plane_y(nx, ny, nz, d, x, z)
            points.append((x, y, z))

    return points
    
def standable_polygon_from_tri(
    tri_flat,
    y_target,
    y_range
):
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

    if abs(ny) < 1e-6:
        return None  # vertical wall

    y_min = y_target - y_range
    y_max = y_target + y_range

    v0 = (x0, y0, z0)
    v1 = (x1, y1, z1)
    v2 = (x2, y2, z2)

    pts = []
    pts += clip_edge_y_band(v0, v1, nx, ny, nz, d, y_min, y_max)
    pts += clip_edge_y_band(v1, v2, nx, ny, nz, d, y_min, y_max)
    pts += clip_edge_y_band(v2, v0, nx, ny, nz, d, y_min, y_max)

    # deduplicate (important)
    unique = []
    for p in pts:
        if not any(
            abs(p[0] - q[0]) < 1e-5 and
            abs(p[1] - q[1]) < 1e-5 and
            abs(p[2] - q[2]) < 1e-5
            for q in unique
        ):
            unique.append(p)

    if len(unique) < 3:
        return None

    return unique  # length 3 or 4
    
def format_poly_line(points):
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

            poly = standable_polygon_from_tri(
                tri,
                y_target=y_target,
                y_range=y_range
            )

            if poly:
                out_lines.append(format_poly_line(poly))

    with open(output_path, "w") as f:
        f.write("\n".join(out_lines))

export_standable_polys(
    input_path="tris.txt",
    output_path="standable_polys.txt",
    y_target=-380.0,
    y_range=5.0
)
        