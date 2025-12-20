import numpy as np

def point_on_edge_at_y_f32(
    x0, y0, z0,
    x1, y1, z1,
    y_target,
    y_range=5.0
):
    # force f32
    x0 = np.float32(x0)
    y0 = np.float32(y0)
    z0 = np.float32(z0)
    x1 = np.float32(x1)
    y1 = np.float32(y1)
    z1 = np.float32(z1)
    y_target = np.float32(y_target)
    y_range = np.float32(y_range)

    min_y = np.minimum(y0, y1)
    max_y = np.maximum(y0, y1)

    # range test
    if y_target < min_y - y_range or y_target > max_y + y_range:
        return None

    dy = y1 - y0
    if np.abs(dy) < np.float32(1e-6):
        return None  # horizontal edge

    # clamp Y onto the segment
    y_use = np.minimum(np.maximum(y_target, min_y), max_y)

    # solve t from Y
    t = (y_use - y0) / dy

    # interpolate
    x = x0 + t * (x1 - x0)
    z = z0 + t * (z1 - z0)

    # ensure f32 outputs
    return (
        np.float32(x),
        np.float32(y_use),
        np.float32(z),
    )


# -------------------------------
# Example using your edge
# -------------------------------

result = point_on_edge_at_y_f32(
    292,-80,2605,291.5271,
    346.04071,2604.1189,
    y_target=300.0,
    y_range=305.0
)

if result is None:
    print("No intersection")
else:
    x, y, z = result
    # print with explicit f32 formatting
    print(f"x={x:.7f}, y={y:.7f}, z={z:.7f}")