import numpy as np
import json

COLPOLY_NORMAL_FRAC = np.float32(1.0 / 32767.0)

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

def minimal_triangle_points(flat_tri):
    tri_verts, nx, ny, nz, d = parse_triangle_flat(flat_tri)
    points = []
    for v in tri_verts:
        y = plane_y_at_xz_f32(nx, ny, nz, d, v[0], v[2])
        points.append((v[0], y, v[2]))
    return points

def generate_all_triangles(flat_tris):
    """Return a list of triangles, each triangle is a list of 3 (x,y,z) points"""
    return [minimal_triangle_points(flat) for flat in flat_tris]

flat_tris = [
    [292, -80, 2605, 480, -280, 2507, 480, -80, 2506, 15146, 78, 29056, -2444.7685546875]
]

triangles = []
for flat in flat_tris:
    tri_points = minimal_triangle_points(flat)
    # skip points with None y
    tri_points = [p for p in tri_points if p[1] is not None]
    if tri_points:  # only add triangles with valid points
        triangles.append(tri_points)

# convert numpy.float32 to regular float
triangles_serializable = [[[float(c) for c in v] for v in tri] for tri in triangles]

with open("standable_triangles.json", "w") as f:
    json.dump(triangles_serializable, f)