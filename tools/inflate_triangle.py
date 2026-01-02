import math

COLPOLY_NORMAL_FRAC = 1.0 / 32767.0

# --------------------------------------------------------
# Helpers
# --------------------------------------------------------
def normalize(v):
    x, z = v
    L = math.hypot(x, z)
    if L == 0:
        return (0.0, 0.0)
    return (x/L, z/L)

def y_from_plane(x, z, Nx, Ny, Nz, d):
    return -(Nx*x + Nz*z + d) / Ny

# --------------------------------------------------------
# Safe 3-point inflated triangle
# --------------------------------------------------------
def offset_triangle_3points(vertices, offset):
    """
    vertices: list of 3 (x, z) tuples
    offset: distance to inflate
    returns 3 points
    """
    result = []
    V = vertices
    for i in range(3):
        prev = V[(i-1)%3]
        curr = V[i]
        nxt = V[(i+1)%3]

        # direction vectors from current to neighbors
        v1 = normalize((prev[0]-curr[0], prev[1]-curr[1]))
        v2 = normalize((nxt[0]-curr[0], nxt[1]-curr[1]))

        # bisector (outward)
        bx, bz = normalize((-(v1[0]+v2[0]), -(v1[1]+v2[1])))

        # single inflated point
        inflated = (curr[0] + bx*offset, curr[1] + bz*offset)
        result.append(inflated)

    return result

# --------------------------------------------------------
# Main wrapper
# --------------------------------------------------------
def inflate_triangle_3points(tri_data, offset=1.0):
    x1, y1, z1, x2, y2, z2, x3, y3, z3, Nx_i, Ny_i, Nz_i, d = tri_data

    Nx = Nx_i * COLPOLY_NORMAL_FRAC
    Ny = Ny_i * COLPOLY_NORMAL_FRAC
    Nz = Nz_i * COLPOLY_NORMAL_FRAC

    # Original triangle in 3D
    original_3d = [(x1, y1, z1), (x2, y2, z2), (x3, y3, z3)]
    print("Original triangle (3D):")
    for p in original_3d:
        print(p)

    # XZ-plane version
    verts_2d = [(x1, z1), (x2, z2), (x3, z3)]
    print("\nTriangle in XZ plane:")
    for p in verts_2d:
        print(p)

    # Inflated XZ-plane polygon (3 points)
    poly_xz = offset_triangle_3points(verts_2d, offset)
    print("\nInflated triangle in XZ plane (3 points):")
    for p in poly_xz:
        print(p)

    # Final 3D polygon
    poly_3d = [(x, y_from_plane(x, z, Nx, Ny, Nz, d), z) for x, z in poly_xz]
    print("\nFinal 3D inflated triangle (3 points):")
    for p in poly_3d:
        print(p)

    return poly_3d

# --------------------------------------------------------
# Example triangle
# --------------------------------------------------------


tri_data = ( # floor
    857, 140, -2088, 878, 162, -2187, 830, 140, -2123, -7119, 31509, 5492, 402
)
tri_data = ( # wall
    878, 162, -2187, 829, 119, -2123, 830, 140, -2123, -26400, 1257, -19368, -592
)

inflated_triangle = inflate_triangle_3points(tri_data, offset=1.0)
