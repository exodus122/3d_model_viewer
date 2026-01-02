import numpy as np

COLPOLY_NORMAL_FRAC = np.float32(1.0 / 32767.0)
CHK_DIST = np.float32(1.0)

def parse_triangle_flat(flat):
    v0 = (np.float32(flat[0]), np.float32(flat[1]), np.float32(flat[2]))
    v1 = (np.float32(flat[3]), np.float32(flat[4]), np.float32(flat[5]))
    v2 = (np.float32(flat[6]), np.float32(flat[7]), np.float32(flat[8]))
    nx = np.float32(flat[9]) * COLPOLY_NORMAL_FRAC
    ny = np.float32(flat[10]) * COLPOLY_NORMAL_FRAC
    nz = np.float32(flat[11]) * COLPOLY_NORMAL_FRAC
    d  = np.float32(flat[12])
    return (v0, v1, v2), nx, ny, nz, d

def plane_y_at_xz_f32(nx, ny, nz, d, x, z):
    if abs(ny) < np.float32(1e-6):
        return None
    return np.float32(((-nx*x) - (nz*z) - d) / ny)

def standable_perimeter_points(flat_tri):
    tri_verts, nx, ny, nz, d = parse_triangle_flat(flat_tri)

    # Basic vertices
    perimeter = list(tri_verts)

    # Optional: offset vertices by CHK_DIST along X/Z directions (engine leniency)
    offsets = [
        (CHK_DIST, 0),
        (-CHK_DIST, 0),
        (0, CHK_DIST),
        (0, -CHK_DIST)
    ]
    for v in tri_verts:
        for ox, oz in offsets:
            x = v[0] + ox
            z = v[2] + oz
            y = plane_y_at_xz_f32(nx, ny, nz, d, x, z)
            if y is not None:
                perimeter.append((x, y, z))

    # Sort points clockwise around centroid to make a proper polygon
    cx = np.mean([p[0] for p in perimeter])
    cz = np.mean([p[2] for p in perimeter])
    def angle(p):
        return np.arctan2(p[2]-cz, p[0]-cx)
    perimeter.sort(key=angle)

    return perimeter
    
flat_tri = [292, -80, 2605, 480, -280, 2507, 480, -80, 2506, 15146, 78, 29056, -2444.7685546875]
polygon = standable_perimeter_points(flat_tri)

for p in polygon:
    print(f"x={p[0]:.7f}, y={p[1]:.7f}, z={p[2]:.7f}")