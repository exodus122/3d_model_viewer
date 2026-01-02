import math
import numpy as np

COLPOLY_NORMAL_FRAC = 1.0 / 32767.0


def compute_y_from_plane(nx, ny, nz, d, x, z):
    if abs(ny) < 1e-8:
        return float("inf")
    return -(nx * x + nz * z + d) / ny


def det_test_xz(v0, v1, v2, x, z):
    def det(ax, az, bx, bz, cx, cz):
        return (bx - ax)*(cz - az) - (bz - az)*(cx - ax)

    d0 = det(v0[0], v0[2], v1[0], v1[2], x, z)
    d1 = det(v1[0], v1[2], v2[0], v2[2], x, z)
    d2 = det(v2[0], v2[2], v0[0], v0[2], x, z)

    has_pos = (d0 > 0) or (d1 > 0) or (d2 > 0)
    has_neg = (d0 < 0) or (d1 < 0) or (d2 < 0)

    return not (has_pos and has_neg)


def cir_square_vs_tri_square(x0, z0, x1, z1, x2, z2, px, pz, chkDist):
    minx = min(x0, x1, x2) - chkDist
    maxx = max(x0, x1, x2) + chkDist
    minz = min(z0, z1, z2) - chkDist
    maxz = max(z0, z1, z2) + chkDist
    return (minx <= px <= maxx) and (minz <= pz <= maxz)


def point_dist_sq_to_line_2d(px, pz, ax, az, bx, bz):
    abx = bx - ax
    abz = bz - az
    apx = px - ax
    apz = pz - az

    ab_len_sq = abx*abx + abz*abz
    if ab_len_sq < 1e-9:
        return {"hit": False, "d2": float("inf")}

    t = (apx*abx + apz*abz) / ab_len_sq
    if 0.0 <= t <= 1.0:
        cx = ax + t * abx
        cz = az + t * abz
        dx = px - cx
        dz = pz - cz
        return {"hit": True, "d2": dx*dx + dz*dz}
    else:
        return {"hit": False, "d2": float("inf")}


# ======================================================================
#                   MAIN FUNCTION
# ======================================================================
def sampled_standable_footprint2(tri_data, resolution=0.25):
    if len(tri_data) != 13:
        raise ValueError("tri_data must contain exactly 13 numbers")

    # unpack like JS code
    v0 = tri_data[0:3]
    v1 = tri_data[3:6]
    v2 = tri_data[6:9]
    nx, ny, nz = tri_data[9:12]
    d = tri_data[12]

    # convert OoT fixed normals
    nx *= COLPOLY_NORMAL_FRAC
    ny *= COLPOLY_NORMAL_FRAC
    nz *= COLPOLY_NORMAL_FRAC

    chkDist = 1.0

    xs = [v0[0], v1[0], v2[0]]
    zs = [v0[2], v1[2], v2[2]]

    minX = min(xs) - chkDist
    maxX = max(xs) + chkDist
    minZ = min(zs) - chkDist
    maxZ = max(zs) + chkDist

    minVertexY = min(v0[1], v1[1], v2[1])

    results = []

    x = minX
    while x <= maxX:
        z = minZ
        while z <= maxZ:
            y = compute_y_from_plane(nx, ny, nz, d, x, z)

            if y >= minVertexY:
                if cir_square_vs_tri_square(
                        v0[0], v0[2], v1[0], v1[2], v2[0], v2[2],
                        x, z, chkDist):

                    chkDistSq = chkDist * chkDist

                    # vertex distance check
                    if ((v0[0] - x)**2 + (v0[2] - z)**2 < chkDistSq or
                        (v1[0] - x)**2 + (v1[2] - z)**2 < chkDistSq or
                        (v2[0] - x)**2 + (v2[2] - z)**2 < chkDistSq):

                        results.append((x, y, z))

                    elif det_test_xz(v0, v1, v2, x, z):
                        results.append((x, y, z))

                    elif abs(ny) > 0.5:
                        L0 = point_dist_sq_to_line_2d(x, z, v0[0], v0[2], v1[0], v1[2])
                        L1 = point_dist_sq_to_line_2d(x, z, v1[0], v1[2], v2[0], v2[2])
                        L2 = point_dist_sq_to_line_2d(x, z, v2[0], v2[2], v0[0], v0[2])
                        if ((L0["hit"] and L0["d2"] < chkDistSq) or
                            (L1["hit"] and L1["d2"] < chkDistSq) or
                            (L2["hit"] and L2["d2"] < chkDistSq)):

                            results.append((x, y, z))

            z += resolution
        x += resolution

    return results
    
def print_points_as_csv(points):
    print("x,y,z")
    for (x, y, z) in points:
        x32 = np.float32(x)
        y32 = np.float32(y)
        z32 = np.float32(z)
        print(f"{x32},{y32},{z32}")

tri_data = (
    -1272, 60, -834,
    -1276, 0, -834,
    -1115, 1, -841,
    1380, -35, 32737,
    886.93
)

pts = sampled_standable_footprint2(tri_data, resolution=0.25)

print("Found", len(pts), "points")
#print(pts)
print_points_as_csv(pts)
#print(pts[:10])