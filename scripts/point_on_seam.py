# find a point on the triangle in the given xyz range which can be stood on

import numpy as np

COLPOLY_NORMAL_FRAC = np.float32(1.0 / 32767.0)

def unpack_tri_flat(data):
    (
        x0, y0, z0,
        x1, y1, z1,
        x2, y2, z2,
        nx_i, ny_i, nz_i,
        d
    ) = data

    tri_verts = (
        (x0, y0, z0),
        (x1, y1, z1),
        (x2, y2, z2),
    )

    nx = np.float32(nx_i) * COLPOLY_NORMAL_FRAC
    ny = np.float32(ny_i) * COLPOLY_NORMAL_FRAC
    nz = np.float32(nz_i) * COLPOLY_NORMAL_FRAC
    d  = np.float32(d)

    return tri_verts, nx, ny, nz, d

def plane_y_at_xz_f32(nx, ny, nz, d, x, z):
    return np.float32(((-nx * x) - (nz * z) - d) / ny)

def point_in_tri_xz_f32(v0, v1, v2, x, z):
    x = np.float32(x)
    z = np.float32(z)

    x0, z0 = np.float32(v0[0]), np.float32(v0[2])
    x1, z1 = np.float32(v1[0]), np.float32(v1[2])
    x2, z2 = np.float32(v2[0]), np.float32(v2[2])

    dX = x - x2
    dZ = z - z2
    dX21 = x2 - x1
    dZ12 = z1 - z2
    D = dZ12 * (x0 - x2) + dX21 * (z0 - z2)
    s = dZ12 * dX + dX21 * dZ
    t = (z2 - z0) * dX + (x0 - x2) * dZ

    if D < 0:
        return s <= 0 and t <= 0 and s + t >= D
    return s >= 0 and t >= 0 and s + t <= D
    
def find_standable_point(
    tri_verts,     # [(x,y,z), (x,y,z), (x,y,z)]
    nx, ny, nz, d,
    x_min, x_max,
    z_min, z_max,
    step,
    y_target,
    y_range
):
    nx = np.float32(nx)
    ny = np.float32(ny)
    nz = np.float32(nz)
    d  = np.float32(d)

    best = None
    best_err = None

    x = x_min
    while x <= x_max:
        z = z_min
        while z <= z_max:
            if point_in_tri_xz_f32(tri_verts[0], tri_verts[1], tri_verts[2], x, z):
                y = plane_y_at_xz_f32(nx, ny, nz, d, x, z)
                err = abs(y - y_target)
                if err <= y_range:
                    if best is None or err < best_err:
                        best = (np.float32(x), np.float32(y), np.float32(z))
                        best_err = err
            z += step
        x += step

    return best

def point_on_edge_in_y_band_f32(
    v0, v1,          # (x, z) endpoints of the edge
    nx, ny, nz, d,   # plane
    y_target,
    y_range
):
    # f32 everything
    x0, z0 = np.float32(v0[0]), np.float32(v0[1])
    x1, z1 = np.float32(v1[0]), np.float32(v1[1])

    nx = np.float32(nx)
    ny = np.float32(ny)
    nz = np.float32(nz)
    d  = np.float32(d)

    y_target = np.float32(y_target)
    y_range  = np.float32(y_range)

    # plane height at edge endpoints
    y0 = plane_y_at_xz_f32(nx, ny, nz, d, x0, z0)
    y1 = plane_y_at_xz_f32(nx, ny, nz, d, x1, z1)

    y_min = y_target - y_range
    y_max = y_target + y_range

    # check overlap
    seg_min = np.minimum(y0, y1)
    seg_max = np.maximum(y0, y1)

    if seg_max < y_min or seg_min > y_max:
        return None  # edge never enters Y band

    # solve t where edge ENTERS the band
    dy = y1 - y0
    if abs(dy) < np.float32(1e-6):
        t = np.float32(0.0)
    else:
        t0 = (y_min - y0) / dy
        t1 = (y_max - y0) / dy
        t = np.maximum(np.minimum(t0, t1), np.float32(0.0))

    # clamp to segment
    t = np.minimum(np.maximum(t, np.float32(0.0)), np.float32(1.0))

    # compute final point
    x = x0 + t * (x1 - x0)
    z = z0 + t * (z1 - z0)
    y = plane_y_at_xz_f32(nx, ny, nz, d, x, z)

    return np.float32(x), np.float32(y), np.float32(z)
    

# vtx1A vtx1B vtx1C vtx2A vtx2B vtx2C vtx3A vtx3B vtx3C normalX normalY normalZ dist
tri_data = (
    -1272, 60, -834, -1276, 0, -834, -1115, 1, -841, 1380, -35, 32737, 886.93
)

tri_verts, nx, ny, nz, d = unpack_tri_flat(tri_data)

result = find_standable_point(
    tri_verts=tri_verts,
    nx=nx, ny=ny, nz=nz, d=d,
    x_min=-1140, x_max=-1100,
    z_min=-860, z_max=-820,
    step=0.1,
    y_target=80,
    y_range=20.0
)

if result:
    x, y, z = result
    print(f"x={x:.7f}, y={y:.7f}, z={z:.7f}")
else:
    print("no point in band")
