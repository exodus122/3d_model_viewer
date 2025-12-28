import json
import numpy as np
import alphashape
from shapely.geometry import Point, Polygon, MultiPoint
from scipy.spatial import Delaunay

# -------------------------------
# 1. Load points from JSON file
# -------------------------------
with open("point_cloud.json", "r") as f:
    data = json.load(f)

# Convert to Nx3 numpy array (x, y, z)
points = np.array([[p["x"], p["y"], p["z"]] for p in data])

# -------------------------------
# 2. Alpha shape (concave hull)
# -------------------------------
# alphashape only works in 2D, so we need a trick:
# - Project points to 3D convex hull triangulation
# - Keep only surface triangles

# For simplicity, let's start with 3D convex hull as base
from scipy.spatial import ConvexHull

hull = ConvexHull(points)
vertices = points.tolist()
faces = hull.simplices.tolist()  # list of triangles

# -------------------------------
# 3. Export to JSON for Three.js
# -------------------------------
output = {
    "vertices": vertices,
    "faces": faces
}

with open("mesh.json", "w") as f:
    json.dump(output, f, indent=2)

print(f"Exported mesh with {len(vertices)} vertices and {len(faces)} faces.")