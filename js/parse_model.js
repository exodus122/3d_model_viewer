import * as THREE from 'three';
import { addModelCheckbox, buildGeometry, buildGeometry_fwc, buildGeometryFromTriangles, buildGeometryEdges } from './render.js';
import { buildGeometry2, buildGeometry3, buildGeometry4 } from './gap.js';
import { initColCtx, initializeSubdivisions, BGCHECK_SUBDIV_OVERLAP } from './subdivisions.js';
import { renderStandableSurfaceXZ, renderStandableSurfaceXZ_old, renderCollisionWallsXY, renderCollisionWallsYZ } from './standable_surfaces.js';
import { scanAndBuildFlatGroundMarkers, buildSurfaceTypeMarkers, scanAndBuildSubdivision } from './poly_markers.js'
import { buildWaterBoxModel } from './waterboxes.js';

const wireframeCheckbox = document.getElementById('wireframe');
const surfaceTypeDropdown = document.getElementById("surfaceTypeDropdown");
const groundClipBandsCheckbox = document.getElementById('groundClipBandsCheckbox');

// The collision context (subdivisions, bounds, etc.) for the last-parsed
// OOT/MM/OOT3D/MM3D collision map. Set once initializeSubdivisions has
// finished populating it, so consumers (e.g. selection.js's sample point
// generator) always see a fully-built colCtx rather than a half-initialized
// one. This is a live export binding, so importers see updates whenever a
// new map is parsed.
//
// Deliberately only ever SET here, never reset to null elsewhere: several
// of the other loaders in this file (invisible seams, secondary/overlay
// models, etc.) can be loaded alongside an already-loaded collision map
// rather than replacing it, so clearing this on their load would wipe out
// a colCtx that's still valid and still in use.
export let currentColCtx = null;

////////////////////////////////////////
// System: Model Parsing (text vs binary dispatch)
////////////////////////////////////////

// Detect binary vs text simple heuristic
export function parseModel(scene, buffer){
    if(typeof buffer === 'string') { parseInvisibleSeams1D(scene, buffer); return; }
    const uint8 = new Uint8Array(buffer);
    let isText = true;
    for(let i=0;i<Math.min(64,uint8.length);i++){
        const c = uint8[i];
        if(c===9||c===10||c===13) continue;
        if(c<32 || c>126){ isText=false; break; }
    }
    if(isText && (game == "OOT" || game == "MM")) parseZeldaModelTextTriangles(scene, new TextDecoder().decode(buffer), true);
    else if(isText) parseInvisibleSeams1D(scene, new TextDecoder().decode(buffer));
    else {
        if(game == "BK" || game == "BT")
                parseBKModelBinary(scene, buffer, true);
        else if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D")
                parseZeldaModelBinary(scene, buffer, true, "");
        else
                parseModelBinary(scene, buffer);
    }
}

// Text format: lines with "v x y z" and "f i j k" (1-based or 0-based)
export function parseModelText(scene, text){
    const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&s[0]!="#");
    const verts = [];
    const tris = [];
    for(const l of lines){
        const parts = l.split(/\s+/);
        if(parts[0].toLowerCase()==='v' && parts.length>=4){
            verts.push( [parseInt(parts[1],10),parseInt(parts[2],10),parseInt(parts[3],10)] );
        } else if((parts[0].toLowerCase()==='f'||parts[0].toLowerCase()==='t') && parts.length>=4){
            const a = parseInt(parts[1],10);
            const b = parseInt(parts[2],10);
            const c = parseInt(parts[3],10);
            tris.push([a,b,c]);
        }
    }
    if(verts.length>0 && tris.length>0){
        const allIdx = [].concat(...tris);
        const maxIdx = Math.max(...allIdx);
        const minIdx = Math.min(...allIdx);
        if(minIdx>=1 && maxIdx<=verts.length) {
            for(let i=0;i<tris.length;i++) tris[i]=tris[i].map(x=>x-1);
        }
    }
    buildGeometry(scene, verts, tris, null, null, "Main Model", true);
}

// Binary format: [uint16 vertexCount][uint16 triCount] then vertexCount*(int16 x,y,z) then triCount*(uint16 a,b,c)
export function parseModelBinary(scene, buffer){
    const dv = new DataView(buffer);
    if(dv.byteLength<4){ alert('binary too small'); return; }
    let offset = 0;
    const vertexCount = dv.getUint16(offset,true); offset+=2;
    const triCount = dv.getUint16(offset,true); offset+=2;
    const verts = [];
    for(let i=0;i<vertexCount;i++){
        if(offset+6>dv.byteLength) break;
        const x = dv.getInt16(offset,true); offset+=2;
        const y = dv.getInt16(offset,true); offset+=2;
        const z = dv.getInt16(offset,true); offset+=2;
        verts.push([x,y,z]);
    }
    //console.log(verts)
    const tris = [];
    for(let i=0;i<triCount;i++){
        if(offset+6>dv.byteLength) break;
        const a = dv.getUint16(offset,true); offset+=2;
        const b = dv.getUint16(offset,true); offset+=2;
        const c = dv.getUint16(offset,true); offset+=2;
        tris.push([a,b,c]);
    }
    //console.log(tris)
    const allIdx = [].concat(...tris);
    const maxIdx = Math.max(...allIdx);
    const minIdx = Math.min(...allIdx);
    if(minIdx>=1 && maxIdx<=verts.length) {
        for(let i=0;i<tris.length;i++) tris[i]=tris[i].map(x=>x-1);
    }
    buildGeometry(scene, verts, tris, null, null, "Main Model", true);
}

export function parseBKModelBinary(scene, buffer, fresh){
    const dv = new DataView(buffer);
    if (dv.byteLength < 4) {
        alert('binary too small');
        return;
    }

    let vtx_list_offset = dv.getUint32(0x10, false);
    //console.log("vtx_list_offset is " + vtx_list_offset.toString(16));

    // original vertexCount is ignored now
    // const vertexCount = dv.getInt16(vtx_list_offset + 0x14, false);
    // console.log("vertexCount is " + vertexCount.toString(16));

    let offset = vtx_list_offset + 0x18;

    const verts = [];
    while (offset + 0x10 <= dv.byteLength) {
        const x = dv.getInt16(offset, false); offset += 2;
        const y = dv.getInt16(offset, false); offset += 2;
        const z = dv.getInt16(offset, false); offset += 2;

        // skip the remaining 10 bytes of this vertex record
        offset += 10;

        verts.push([x, y, z]);
    }

    //console.log(verts);
    
    let collision_list_offset = dv.getUint32(0x1C,false);
    //console.log("collision_list_offset is "+collision_list_offset.toString(16))
    const geoCount = dv.getInt16(collision_list_offset+0x10,false);
    //console.log("geoCount is "+geoCount.toString(16))
    const triCount = dv.getInt16(collision_list_offset+0x14,false);
    //console.log("triCount is "+triCount.toString(16))
    
    
    offset = collision_list_offset + 0x18 + geoCount * 4;
    //console.log("startTriList is "+offset.toString(16))
    const tris = [];
    for(let i=0;i<triCount;i++){
        if(offset+0xC>dv.byteLength) break;
        const a = dv.getInt16(offset,false)+1; offset+=2;
        const b = dv.getInt16(offset,false)+1; offset+=2;
        const c = dv.getInt16(offset,false)+1; offset+=2;
        offset+=6;
        tris.push([a,b,c]);
    }
    
    //console.log(tris);
    
    const allIdx = [].concat(...tris);
    const maxIdx = Math.max(...allIdx);
    const minIdx = Math.min(...allIdx);
    if(minIdx>=1 && maxIdx<=verts.length) {
        for(let i=0;i<tris.length;i++) tris[i]=tris[i].map(x=>x-1);
    }
    
    let modelName = "Main Model";
    if(!fresh)
        modelName = `Model ${loadedModels.length+1}`;
    
    buildGeometry(scene, verts, tris, null, null, modelName, fresh);
}

function parseZeldaModelTextTriangles(scene, text, fresh) {
    const lines = text
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && s[0] !== "#");
    
    const verts = [];
    const vertMap = new Map(); // "x,y,z" -> index
    const tris = [];

    function getVertIndex(v) {
        const key = v.join(",");
        if (vertMap.has(key)) return vertMap.get(key);
        const idx = verts.length;
        verts.push(v);
        vertMap.set(key, idx);
        return idx;
    }

    for (const line of lines) {
        const p = line.split(",").map(Number);
        if (p.length !== 9) continue;

        const v1 = p.slice(0, 3);
        const v2 = p.slice(3, 6);
        const v3 = p.slice(6, 9);

        const a = getVertIndex(v1);
        const b = getVertIndex(v2);
        const c = getVertIndex(v3);

        tris.push([a, b, c]);
    }

    // sanity check (matches your binary loader behavior)
    for (let i = 0; i < tris.length; i++) {
        const [a, b, c] = tris[i];
        if (
            a < 0 || b < 0 || c < 0 ||
            a >= verts.length ||
            b >= verts.length ||
            c >= verts.length
        ) {
            //console.warn("Invalid triangle index", i, tris[i]);
        }
    }
    
    let modelName = "Main Model";
    if(!fresh)
      modelName = `Model ${loadedModels.length+1}`;
    
    if (display_fwc.checked)
        buildGeometry_fwc(scene, verts, tris, modelName, fresh);
    else
        buildGeometry(scene, verts, tris, null, null, modelName, fresh);
}

// Build a wireframe grid of the subdivision cell boundaries: one line per
// cell-boundary plane intersection, spanning the full bounds - NOT one box
// per cell (which would draw every internal face's edges once per
// neighboring cell that shares it). Deliberately uses colCtx.minBounds /
// subdivLength / subdivAmount directly (the raw grid) rather than
// colCtx.subdivisions[i].bounds - same numbers, but this makes clear the
// lines are the bare cell boundaries with BGCHECK_SUBDIV_OVERLAP NOT
// applied, unlike the padded bounds subdivisions.js hands out for actual
// polygon-registration/overlap checks (getSubdivisionBoundsForIndex there
// pads each cell by the overlap in every direction - this grid intentionally
// does not, so it shows the true, non-overlapping cell partition).
function buildSubdivisionGridEdges(colCtx) {
    const verts = [];
    const vertMap = new Map();
    const edges = [];

    function getVertIndex(x, y, z) {
        const key = x + "," + y + "," + z;
        let idx = vertMap.get(key);
        if (idx === undefined) {
            idx = verts.length;
            verts.push([x, y, z]);
            vertMap.set(key, idx);
        }
        return idx;
    }

    const { minBounds, subdivLength, subdivAmount } = colCtx;
    const NX = subdivAmount.x, NY = subdivAmount.y, NZ = subdivAmount.z;
    const minX = minBounds.x, minY = minBounds.y, minZ = minBounds.z;
    const maxX = minX + subdivLength.x * NX;
    const maxY = minY + subdivLength.y * NY;
    const maxZ = minZ + subdivLength.z * NZ;

    // Lines parallel to X: one per (Y-plane, Z-plane) intersection.
    for (let yi = 0; yi <= NY; yi++) {
        const y = minY + subdivLength.y * yi;
        for (let zi = 0; zi <= NZ; zi++) {
            const z = minZ + subdivLength.z * zi;
            edges.push([getVertIndex(minX, y, z), getVertIndex(maxX, y, z)]);
        }
    }
    // Lines parallel to Y: one per (X-plane, Z-plane) intersection.
    for (let xi = 0; xi <= NX; xi++) {
        const x = minX + subdivLength.x * xi;
        for (let zi = 0; zi <= NZ; zi++) {
            const z = minZ + subdivLength.z * zi;
            edges.push([getVertIndex(x, minY, z), getVertIndex(x, maxY, z)]);
        }
    }
    // Lines parallel to Z: one per (X-plane, Y-plane) intersection.
    for (let xi = 0; xi <= NX; xi++) {
        const x = minX + subdivLength.x * xi;
        for (let yi = 0; yi <= NY; yi++) {
            const y = minY + subdivLength.y * yi;
            edges.push([getVertIndex(x, y, minZ), getVertIndex(x, y, maxZ)]);
        }
    }

    return { verts, edges };
}


// DIAGNOSTIC: BgCheck_GetStaticLookupIndicesFromPos (the real game's static
// subdivision lookup) computes sector.y as
// (s32)((checkPos.y - minBounds.y) * subdivLengthInv.y), and
// BgCheck_RaycastFloorImpl's floor raycast starts checkPos.y at
// pos.y + BGCHECK_SUBDIV_OVERLAP, then repeatedly SUBTRACTS subdivLength.y
// from checkPos.y until it drops below minBounds.y. Because subdivLengthInv.y
// is itself a rounded f32 (1/subdivLength.y is essentially never exactly
// representable), a checkPos.y landing close enough to a row boundary can
// round down and have the (s32) cast truncate it into the row BELOW where it
// belongs - silently skipping that row's collision entirely for this
// raycast.
//
// Returns the f32 value `steps` ULPs away from `v` (negative steps = down).
// Standard "biased key" bit trick: reinterpret the IEEE754 bit pattern as a
// monotonically-increasing unsigned integer (flip all bits if negative, else
// just set the sign bit), so integer +/-1 on that key is exactly +/-1 ULP in
// the real value, for either sign. Used to scan the representable floats
// around each candidate position, since real gameplay Y values are
// essentially never exactly the "clean" boundary-checkHeight value - see
// logSubdivisionYSkips below.
function f32Step(v, steps) {
    const buf = new ArrayBuffer(4);
    const fv = new Float32Array(buf);
    const iv = new Uint32Array(buf);
    fv[0] = Math.fround(v);
    const bits = iv[0];
    let key = (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits | 0x80000000) >>> 0);
    key = (key + steps) >>> 0;
    iv[0] = (key & 0x80000000) !== 0 ? (key & 0x7fffffff) >>> 0 : (~key >>> 0);
    return fv[0];
}

// For every internal Y row j, this checks heights roughly at that row's
// boundary minus checkHeight (50) - the natural resting position after a
// floor raycast steps down through boundary j - to see if starting a raycast
// there lets it skip any row on its way down to minBounds. It scans an ULP
// neighborhood around the "clean" boundary_j - checkHeight point (real
// gameplay Y is essentially never that exact float) and, for each candidate,
// walks the FULL checkPos.y sequence, recording the row the game ACTUALLY
// computes at every step: trunc(f32((checkY-minY) * invY)), using the
// rounded f32 reciprocal exactly like the real C code (the buggy path).
//
// The loop structure guarantees checkY drops by exactly one row height
// (lenY) every step, so in a bug-free walk the computed row must decrease by
// EXACTLY 1 each step. That invariant is the ground truth here - not an
// externally computed "true row" for each checkY in isolation. A step's own
// computed row can individually look locally consistent (matching a naive
// floor of that specific checkY) while STILL silently skipping a row,
// because accumulated f32 rounding across earlier steps can shift where
// checkY lands just enough that consecutive computed rows jump by 2 instead
// of 1 - each step "agrees with itself" but disagrees with its neighbor.
// (Two earlier versions of this check got this wrong in complementary ways:
// one asked "did the walk ever visit row N", which flagged rows the raycast
// legitimately never reached as false positives; the other compared each
// checkY against its own double-precision floor in isolation, which missed
// exactly this jump-by-2-between-steps case, since each step passed its own
// isolated check.)
//
// Results are grouped by (row skipped, which boundary j the candidate scan
// was centered on) rather than merged across all j: a given row can be
// skipped by candidates clustered near several different boundaries (its own
// boundary directly, or a higher boundary whose multi-step walk passes over
// it), and those clusters sit at completely different pos.y values, so
// merging their min/max would produce a fake "range" spanning the gap
// between clusters instead of the real (tight) neighborhoods around each.
function logSubdivisionYSkips(colCtx) {
    const f32 = Math.fround;
    const minY = colCtx.minBounds.y;
    const lenY = colCtx.subdivLength.y;
    const invY = colCtx.subdivLengthInv.y;
    const amountY = colCtx.subdivAmount.y;
    const checkHeight = BGCHECK_SUBDIV_OVERLAP;

    // How many representable floats on either side of the clean
    // (boundary - checkHeight) candidate to scan. Cheap (a few thousand
    // candidates per boundary, each a walk of amountY+4 steps, trivial at
    // load time) so there's no real cost to being generous here.
    const ULP_RADIUS = 8192;
    // Safety cap on walk steps (real loop always terminates within
    // amountY+1 steps since checkPos.y drops by a full row each time) - just
    // here so a malformed colCtx can't spin forever.
    const MAX_STEPS = amountY + 4;

    // "row,sourceBoundary" -> { row, sourceBoundary, min, max, minS, maxS }
    // range of STARTING pos.y values (not checkPos.y at the failing step)
    // found to skip that row from that boundary's candidate cluster. minS/
    // maxS are the ULP offsets that produced each edge, kept so the log can
    // self-report whether the scan window was actually wide enough.
    const rowRanges = new Map();

    for (let j = 1; j < amountY; j++) {
        const boundaryY = f32(minY + f32(lenY * j));
        const cleanPosY = f32(boundaryY - checkHeight);

        for (let s = -ULP_RADIUS; s <= ULP_RADIUS; s++) {
            const posY = f32Step(cleanPosY, s);

            let checkY = f32(posY + checkHeight);
            let prevComputedRow = null;
            for (let step = 0; step < MAX_STEPS && checkY >= minY; step++) {
                const diff = f32(checkY - minY);
                const computedRow = Math.trunc(f32(diff * invY)); // matches C's float -> s32 cast, using the rounded f32 reciprocal (the buggy path)
                checkY = f32(checkY - lenY);

                if (prevComputedRow !== null && prevComputedRow - computedRow > 1) {
                    // Consecutive steps should only ever move down by exactly
                    // one row - a bigger jump means every row strictly
                    // between them was silently never tested.
                    for (let r = computedRow + 1; r < prevComputedRow; r++) {
                        if (r < 1 || r >= amountY) continue; // outside the internal rows we care about

                        const key = `${r},${j}`;
                        const range = rowRanges.get(key);
                        if (!range) {
                            rowRanges.set(key, { row: r, sourceBoundary: j, min: posY, max: posY, minS: s, maxS: s, jumpFrom: prevComputedRow, jumpTo: computedRow });
                        } else {
                            if (posY < range.min) { range.min = posY; range.minS = s; }
                            if (posY > range.max) { range.max = posY; range.maxS = s; }
                        }
                    }
                }

                prevComputedRow = computedRow;
            }
        }
    }

    const clusters = [...rowRanges.values()].sort((a, b) => (b.row - a.row) || (a.sourceBoundary - b.sourceBoundary));

    if (clusters.length > 0) {
        const rowCount = new Set(clusters.map(c => c.row)).size;
        console.log(`[Subdivision Grid] ${rowCount} row(s) of this map's Y subdivision can be silently skipped by floor raycasts due to float32 rounding:`);
        for (const { row, sourceBoundary, min, max, minS, maxS, jumpFrom, jumpTo } of clusters) {
            const rangeDesc = min === max ? `pos.y = ${min}` : `pos.y in [${min}, ${max}]`;
            // If either edge came from an `s` value at the very edge of the
            // scanned window, the true danger zone likely extends further
            // and ULP_RADIUS needs to be widened again.
            const clipped = minS === -ULP_RADIUS || maxS === ULP_RADIUS;
            const clipNote = clipped ? `  [WARNING: hit edge of +/-${ULP_RADIUS} ULP scan window - range may be wider, increase ULP_RADIUS]` : '';
            console.log(`  ${rangeDesc}  skips subdivision row ${row} (computed row jumps ${jumpFrom} -> ${jumpTo})  (via raycast walking down from row ${sourceBoundary})${clipNote}`);
        }
    } else {
        console.log(`[Subdivision Grid] No subdivision-skipping Y values detected for this map's grid.`);
    }
}

export function parseZeldaModelBinary(scene, buffer, fresh, mapName){

    const dv = new DataView(buffer);
    if (dv.byteLength < 4) {
        alert('binary too small');
        return;
    }
    
    let endianness = false;
    let current_addr = 0x0;
    let address_offset = -0x02000000;
    let poly_length = 0x10;
    if (game == "OOT3D" || game == "MM3D") {
        endianness = true;
        current_addr = 0x10;
        address_offset = 0x10;
        poly_length = 0x14;
        
        if (mapName == "Termina Field (Credits Cutscene 2)")
            current_addr = 0x60;
    }
    
    // Initialize scene data
    let sceneData = {
        rooms: []
    };
    
    // Initialize colHeader
    let colHeader = {
        numVtxs: 0, 
        vtxListStart: 0, 
        numPolygons: 0, 
        polygonListStart: 0,
        minBounds: { x: null, y: null, z: null },
        maxBounds: { x: null, y: null, z: null },
        camType: null
    };
    
    let allTriangleData = [];
    
    let cmd1 = dv.getUint8(current_addr);
    let cmd2 = dv.getUint32(current_addr+0x4, endianness);
    
    while (cmd1 != 0x14) {
        /*if (cmd1 == 0x04) { // rooms
            sceneData.numRooms = dv.getUint8(current_addr+0x1);
            sceneData.roomListStart = dv.getUint32(current_addr+0x4, endianness);
            
            let current_addr2 = sceneData.roomListStart & 0x00FFFFFF;
            
            for(let i = 0; i < sceneData.numRooms; i++) {
                let roomSegmentStart = dv.getUint32(current_addr2 + i*0x8, endianness);
                let roomSegmentEnd = dv.getUint32(current_addr2 + (i+1)*0x8, endianness);
                
                let current_addr3 = roomSegmentStart & 0x00FFFFFF;
                
                let roomCmd1 = dv.getUint8(current_addr3);
                let roomParam1 = dv.getUint8(current_addr3+0x1);
                let roomParam2 = dv.getUint32(current_addr3+0x4, endianness) & 0x00FFFFFF;
                
                while (roomCmd1 != 0x14) {
                    if (roomCmd1 == 0x01) { // actorList
                        sceneData.rooms[i] = {
                            numActors: dv.getUint8(current_addr3+0x1),
                            actorListStart: dv.getUint32(current_addr3+0x4, endianness),
                            actorList: []
                        }
                        
                        // Get ActorList
                        let offset = sceneData.actorListStart & 0x00FFFFFF;
                        for(let i = 0; i < sceneData.numActors; i++){
                            if (offset + i*8 < dv.byteLength - 8) {
                                let actorEntry = {
                                    id: dv.getInt16(offset + i*16 + 0x0, endianness),
                                    pos: [
                                        dv.getInt16(offset + i*16 + 0x2, endianness),
                                        dv.getInt16(offset + i*16 + 0x4, endianness),
                                        dv.getInt16(offset + i*16 + 0x6, endianness)
                                    ],
                                    rot: [
                                        dv.getInt16(offset + i*16 + 0x8, endianness),
                                        dv.getInt16(offset + i*16 + 0xA, endianness),
                                        dv.getInt16(offset + i*16 + 0xC, endianness)
                                    ],
                                    params: dv.getInt16(offset + i*16 + 0xE, endianness)
                                }

                                sceneData.rooms[i].actorList.push(actorEntry);
                            }
                            else {
                                break;
                            }
                        }
                    }
                    
                    current_addr2 = current_addr2 + 0x8;
                    roomCmd1 = dv.getUint8(current_addr2);
                    roomParam1 = dv.getUint8(current_addr2+0x1);
                    roomParam2 = dv.getUint32(current_addr2+0x4, endianness);
                }
            }
        }
        else*/ if (cmd1 == 0x19 && (game == "OOT" || game == "OOT3D")) { // misc_settings
            colHeader.camType = dv.getUint8(current_addr+0x1);
        }
        else if (cmd1 == 0x03) { // collision_header
            //console.log("current_addr: "+current_addr+", "+cmd1+", "+cmd2);
            if (game == "OOT" || game == "MM" || game == "OOT3D") {
                colHeader.minBounds.x = dv.getInt16(cmd2+address_offset+0x00, endianness);
                colHeader.minBounds.y = dv.getInt16(cmd2+address_offset+0x02, endianness);
                colHeader.minBounds.z = dv.getInt16(cmd2+address_offset+0x04, endianness);
                colHeader.maxBounds.x = dv.getInt16(cmd2+address_offset+0x06, endianness);
                colHeader.maxBounds.y = dv.getInt16(cmd2+address_offset+0x08, endianness);
                colHeader.maxBounds.z = dv.getInt16(cmd2+address_offset+0x0A, endianness);
                colHeader.numVtxs = dv.getUint16(cmd2+address_offset+0x0C, endianness);
                
                if (game == "OOT" || game == "MM") {
                    colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x10, endianness);
                    colHeader.numPolygons = dv.getUint16(cmd2+address_offset+0x14, endianness);
                    colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                    colHeader.surfaceTypeListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
                    colHeader.numWaterboxes = dv.getUint16(cmd2+address_offset+0x24, endianness);
                    colHeader.waterboxListStart = dv.getUint32(cmd2+address_offset+0x28, endianness);
                    colHeader.numSurfaceTypes = 200; // there is no numSurfaceTypes in these games, so just get 200 I guess...
                }
                else if (game == "OOT3D") {
                    colHeader.numPolygons = dv.getUint16(cmd2+address_offset+0x0E, endianness);
                    colHeader.numSurfaceTypes = dv.getUint16(cmd2+address_offset+0x10, endianness);
                    colHeader.numWaterboxes = dv.getUint16(cmd2+address_offset+0x14, endianness);
                    colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                    colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
                    colHeader.surfaceTypeListStart = dv.getUint32(cmd2+address_offset+0x20, endianness);
                    colHeader.waterboxListStart = dv.getUint32(cmd2+address_offset+0x28, endianness);
                }
            }
            else if (game == "MM3D") {
                colHeader.minBounds.x = dv.getInt16(cmd2+address_offset+0x02, endianness);
                colHeader.minBounds.y = dv.getInt16(cmd2+address_offset+0x04, endianness);
                colHeader.minBounds.z = dv.getInt16(cmd2+address_offset+0x06, endianness);
                colHeader.maxBounds.x = dv.getInt16(cmd2+address_offset+0x08, endianness);
                colHeader.maxBounds.y = dv.getInt16(cmd2+address_offset+0x0A, endianness);
                colHeader.maxBounds.z = dv.getInt16(cmd2+address_offset+0x0C, endianness);
                colHeader.numVtxs = dv.getUint16(cmd2+address_offset+0x0E, endianness);
                colHeader.numPolygons = dv.getUint16(cmd2+address_offset+0x10, endianness);
                colHeader.numSurfaceTypes = dv.getUint16(cmd2+address_offset+0x12, endianness);
                colHeader.numWaterboxes = dv.getUint16(cmd2+address_offset+0x16, endianness);
                colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
                colHeader.surfaceTypeListStart = dv.getUint32(cmd2+address_offset+0x20, endianness);
                colHeader.waterboxListStart = dv.getUint32(cmd2+address_offset+0x28, endianness);
            }
            break;
        }
        
        current_addr = current_addr + 0x8;
        cmd1 = dv.getUint8(current_addr);
        cmd2 = dv.getUint32(current_addr+0x4, endianness);
    }
    
    
    let colCtx = initColCtx(game, mapName, colHeader);
    
    console.log(game+" - "+mapName+" - numVtxs: "+colHeader.numVtxs+", numPolygons: "+colHeader.numPolygons);
    //console.log("vtxListStart: "+colHeader.vtxListStart);
    //console.log("polygonListStart: "+colHeader.polygonListStart);
    
    // Get SurfaceTypes
    let offset = colHeader.surfaceTypeListStart + address_offset;
    for(let i = 0; i < colHeader.numSurfaceTypes; i++){
        if (offset + i*8 < dv.byteLength - 8) {
            const word1 = dv.getUint32(offset + i*8 + 0x0, endianness);
            const word2 = dv.getUint32(offset + i*8 + 0x4, endianness);
            
            let surfaceObject = {
                horseBlocked:      (word1 >>> 31) & 0x1,
                isSoft:            (word1 >>> 30) & 0x1,
                floorProperty:     (word1 >>> 26) & 0xF,
                wallType:          (word1 >>> 21) & 0x1F,
                unk18:             (word1 >>> 18) & 0x7,
                floorType:         (word1 >>> 13) & 0x1F,
                loadingZone:       (word1 >>> 8)  & 0x1F, // surfaceExitIndex
                bgCamIndex:        (word1 >>> 0)  & 0xFF,
                
                wallDamage:        (word2 >>> 27) & 0x1,
                conveyorDirection: (word2 >>> 21) & 0x3F,
                conveyorSpeed:     (word2 >>> 18) & 0x7,
                canHookshot:       (word2 >>> 17) & 0x1,
                echo:              (word2 >>> 11) & 0x3F,
                lightSetting:      (word2 >>> 6)  & 0x1F,
                floorEffect:       (word2 >>> 4)  & 0x3,
                material:          (word2 >>> 0)  & 0xF
            };
            
            colCtx.surfaceTypes.push(surfaceObject);
        }
        else {
            break;
        }
    }
    
    // Get Vertices
    const verts = [];
    offset = colHeader.vtxListStart + address_offset;
    for(let i = 0; i < colHeader.numVtxs; i++){
        const x = dv.getInt16(offset + i*6 + 0x0, endianness);
        const y = dv.getInt16(offset + i*6 + 0x2, endianness);
        const z = dv.getInt16(offset + i*6 + 0x4, endianness); 

        verts.push([x, y, z]);
    }
    //console.log(verts);
    
    // Get Triangles
    const tris = [];
    const intangibleTris = [];
    const intangibleTriangleData = [];
    offset = colHeader.polygonListStart + address_offset;
    for(let i = 0; i < colHeader.numPolygons; i++){
        if(offset+poly_length > dv.byteLength) break;
        
        let type = dv.getUint16(offset + poly_length*i + 0x0,endianness);
        
        let temp_a = dv.getUint16(offset + poly_length*i + 0x2,endianness);
        const xpFlags = (temp_a & 0xE000) >>> 13;
        const a = temp_a & 0x1FFF;
        
        let temp_b = dv.getUint16(offset + poly_length*i + 0x4,endianness);
        const flags = (temp_b & 0xE000) >>> 13;
        const b = temp_b & 0x1FFF;
        
        const c = dv.getUint16(offset + poly_length*i + 0x6,endianness) & 0x1FFF;
        
        let normX = null, normY = null, normZ = null;
        if (game == "OOT3D") {
            normX = dv.getInt16(offset + poly_length*i + 0xA,endianness);
            normY = dv.getInt16(offset + poly_length*i + 0xC,endianness);
            normZ = dv.getInt16(offset + poly_length*i + 0xE,endianness);
        }
        else {
            normX = dv.getInt16(offset + poly_length*i + 0x8,endianness);
            normY = dv.getInt16(offset + poly_length*i + 0xA,endianness);
            normZ = dv.getInt16(offset + poly_length*i + 0xC,endianness);
        }
        
        //console.log("normal: " + normX + ", " + normY + ", " + normZ)
        let dist = null;
        if (game == "OOT" || game == "MM") {
            dist = dv.getInt16(offset + poly_length*i + 0xE,endianness);
        }
        else {
            dist = dv.getFloat32(offset + poly_length*i + 0x10, endianness);
        }
        
        if (xpFlags & 2) {
            // Intangible collision - excluded from the real collision
            // model/subdivisions (it has no actual collision in-game), but
            // built as its own separate visual-only model below rather
            // than just discarded.
            intangibleTris.push([a+1,b+1,c+1]);
            intangibleTriangleData.push({
                id: i,
                type: type,
                vtxs: [
                    new THREE.Vector3(verts[a][0], verts[a][1], verts[a][2]),
                    new THREE.Vector3(verts[b][0], verts[b][1], verts[b][2]),
                    new THREE.Vector3(verts[c][0], verts[c][1], verts[c][2])
                ],
                normals: [normX, normY, normZ],
                d: dist,
                xpFlags: xpFlags,
                flags: flags
            });
            continue;
        }
        
        tris.push([a+1,b+1,c+1]);
        
        // --- Build triangle object directly for allTriangleData ---
        const vtxs = [
            new THREE.Vector3(verts[a][0], verts[a][1], verts[a][2]),
            new THREE.Vector3(verts[b][0], verts[b][1], verts[b][2]),
            new THREE.Vector3(verts[c][0], verts[c][1], verts[c][2])
        ];

        allTriangleData.push({
            id: i,
            type: type,
            vtxs: vtxs,
            normals: [normX, normY, normZ],
            d: dist,
            xpFlags: xpFlags,
            flags: flags
        });
    }
    //console.log(tris)
    
    initializeSubdivisions(game, colCtx, allTriangleData);
    currentColCtx = colCtx;
    
    // Populate the subdivision dropdown right away, based only on colCtx.
    // Doing this here (rather than after the rest of the scene is built)
    // means the list still gets filled in even if something later in this
    // function throws while building standable surfaces, walls, etc.
    const subdivisionSelector = document.getElementById("subdivisionSelector");
    subdivisionSelector.innerHTML = "";
    colCtx.subdivisions.forEach((sub, idx) => {
        const triCount = sub.floors.length + sub.walls.length + sub.ceilings.length;
        if (triCount === 0) return;
        const option = document.createElement("option");
        option.value = idx;
        // Raw cell bounds (sub.bounds, from initColCtx) - NOT padded by
        // BGCHECK_SUBDIV_OVERLAP, same "true, non-overlapping cell" numbers
        // as the Subdivision Grid / selected-cell cube outline.
        const [[x0, x1], [y0, y1], [z0, z1]] = sub.bounds;
        const r = v => Math.round(v);
        option.textContent = `${idx} (${triCount} tri${triCount === 1 ? '' : 's'})  x:${r(x0)}..${r(x1)} y:${r(y0)}..${r(y1)} z:${r(z0)}..${r(z1)}`;
        subdivisionSelector.appendChild(option);
    });

    const allIdx = [].concat(...tris);
    const maxIdx = Math.max(...allIdx);
    const minIdx = Math.min(...allIdx);
    if(minIdx >= 1 && maxIdx <= verts.length) {
        for(let i = 0; i < tris.length; i++) tris[i]=tris[i].map(x=>x-1);
    }
    
    if (intangibleTris.length > 0) {
        const allIntangibleIdx = [].concat(...intangibleTris);
        const maxIntangibleIdx = Math.max(...allIntangibleIdx);
        const minIntangibleIdx = Math.min(...allIntangibleIdx);
        if(minIntangibleIdx >= 1 && maxIntangibleIdx <= verts.length) {
            for(let i = 0; i < intangibleTris.length; i++) intangibleTris[i]=intangibleTris[i].map(x=>x-1);
        }
    }
    
    for (let i = 0; i < tris.length; i++) {
        const [a,b,c] = tris[i];
        if (a < 0 || b < 0 || c < 0 ||
            a >= verts.length || b >= verts.length || c >= verts.length) {
            console.warn("Invalid triangle index", i, a,b,c, "verts:", verts.length);
        }
    }
    
    let modelName = "Main Model";
    if(!fresh)
        modelName = `Model ${loadedModels.length+1}`;
    
    if (display_fwc.checked)
        buildGeometry_fwc(scene, verts, tris, modelName, fresh);
    else
        buildGeometry(scene, verts, tris, allTriangleData, colCtx, modelName, fresh);

    // Intangible collision (xpFlags & 2) as its own separate model - these
    // polygons have no real collision in-game, so they're deliberately
    // excluded from allTriangleData/colCtx above (not registered in the
    // subdivision system, not considered for sample points or standable
    // surfaces), but are still worth being able to see. Always additive
    // (fresh=false) since the main model above already handled clearing
    // the scene for a fresh load.
    if (intangibleTris.length > 0) {
        buildGeometry(scene, verts, intangibleTris, intangibleTriangleData, null, "Intangible Collision", false);
    }

    // "Subdivision Grid": a wireframe box grid of the subdivision cells
    // themselves (their raw, non-overlap-padded boundaries - see
    // buildSubdivisionGridEdges above), as its own extra toggleable model.
    // Always additive (fresh=false, same reasoning as Intangible Collision
    // above - the main model build already cleared the scene for a fresh
    // load, and this has to run after that clear or it'd get wiped out
    // immediately by it). Off by default (checked=false), same as the
    // single-cell "Subdivision" highlight further down - it's a dev/debug
    // aid, not something you want cluttering every load.
    {
        const { verts: gridVerts, edges: gridEdges } = buildSubdivisionGridEdges(colCtx);
        buildGeometryEdges(scene, gridVerts, gridEdges, "Subdivision Grid", false, false);
        logSubdivisionYSkips(colCtx);
    }

    // groundClipBandsCheckbox: when unchecked, standable surfaces render as
    // just the plain red/blue split (no yellow ground-clippable banding, no
    // cyan fully-clippable fill) - see the groundClipEnabled param on
    // renderStandableSurfaceXZ / buildStandableSurfaceTriangles in
    // standable_surfaces.js. Defaults to checked (band computation on),
    // matching prior behavior. Hidden entirely for BK/BT (main.js's game
    // selector handler), so it's null there - guard with optional chaining.
    const standableSurfaceResult = renderStandableSurfaceXZ(allTriangleData, colCtx, groundClipBandsCheckbox?.checked ?? true);
    if (standableSurfaceResult) {
        const { main: standableSurfaceMain, vertexBulge: standableSurfaceVertexBulge } = standableSurfaceResult;

        if (standableSurfaceMain) {
            scene.add(standableSurfaceMain);

            if (standableSurfaceMain.children[1])
                standableSurfaceMain.children[1].visible = wireframeCheckbox.checked;

            loadedModels.push({ name: "Standable Surface", mesh: standableSurfaceMain, edges: standableSurfaceMain.children[1] });

            addModelCheckbox(scene, "Standable Surface", standableSurfaceMain, null, false, true, "#ff0000");
        }

        if (standableSurfaceVertexBulge) {
            scene.add(standableSurfaceVertexBulge);

            if (standableSurfaceVertexBulge.children[1])
                standableSurfaceVertexBulge.children[1].visible = wireframeCheckbox.checked;

            loadedModels.push({ name: "Seams Model", mesh: standableSurfaceVertexBulge, edges: standableSurfaceVertexBulge.children[1] });

            addModelCheckbox(scene, "Seams Model", standableSurfaceVertexBulge, null, false, true, "#00cc44");
        }
    }
    
    const wallSurfaceMeshXY = renderCollisionWallsXY(allTriangleData);
    if (wallSurfaceMeshXY) {
        wallSurfaceMeshXY.children[1].visible = wireframeCheckbox.checked;
        scene.add(wallSurfaceMeshXY);
        loadedModels.push({ name: "Wall Collision (XY)", mesh: wallSurfaceMeshXY, edges: wallSurfaceMeshXY.children[1] });
        addModelCheckbox(scene, "Wall Collision (XY)", wallSurfaceMeshXY, null, false, false, "#ff0000");
    }
    
    const wallSurfaceMeshYZ = renderCollisionWallsYZ(allTriangleData);
    if (wallSurfaceMeshYZ) {
        scene.add(wallSurfaceMeshYZ);
        wallSurfaceMeshYZ.children[1].visible = wireframeCheckbox.checked;
        loadedModels.push({ name: "Wall Collision (YZ)", mesh: wallSurfaceMeshYZ, edges: wallSurfaceMeshYZ.children[1] });
        addModelCheckbox(scene, "Wall Collision (YZ)", wallSurfaceMeshYZ, null, false, false, "#ff0000");
    }
    
    const flatGroup = scanAndBuildFlatGroundMarkers();
    if (flatGroup) {
        scene.add(flatGroup);
        loadedModels.push({ name: "Flat Ground Clips", mesh: flatGroup, edges: null });
        addModelCheckbox(scene, "Flat Ground Clips", flatGroup, null, false, false, "#00FFFF");
    }
    
    function rebuildSubdivisionVisualization() {
        // Remove the old subdivision mesh from the scene/loadedModels
        const oldIndex = loadedModels.findIndex(m => m.name === "Subdivision");
        if (oldIndex >= 0) {
            const old = loadedModels[oldIndex];
            if (old.mesh) {
                scene.remove(old.mesh);
                old.mesh.traverse(obj => {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) obj.material.dispose();
                });
            }
            loadedModels.splice(oldIndex, 1);
        }

        // Remove its checkbox from the sidebar
        const container = document.querySelector('.controls');
        if (container) {
            const oldCheckbox = Array.from(container.children).find(
                child => child.dataset && child.dataset.modelName === "Subdivision"
            );
            if (oldCheckbox) container.removeChild(oldCheckbox);
        }

        const subdivisionGroup = scanAndBuildSubdivision();
        if (subdivisionGroup) {
            scene.add(subdivisionGroup);
            // edges: the cube outline specifically (subdivisionGroup.userData.cubeEdges,
            // set in scanAndBuildSubdivision) - not the merged triangle-outline
            // LineSegments also in this group, so only the cube's edges become
            // individually clickable, not every triangle edge in the highlight.
            // edgeSelectable opts into selection.js's edge-picking pass.
            loadedModels.push({
                name: "Subdivision",
                mesh: subdivisionGroup,
                edges: subdivisionGroup.userData.cubeEdges || null,
                edgeSelectable: true
            });
            addModelCheckbox(scene, "Subdivision", subdivisionGroup, null, false, false, "#00FFFF");
        }
    }

    // Assigning to .onchange (rather than addEventListener) means loading a
    // new map replaces the previous handler instead of stacking another one.
    subdivisionSelector.onchange = rebuildSubdivisionVisualization;

    rebuildSubdivisionVisualization();
    
    buildSurfaceTypeMarkers(scene);
    
    
    // Parse and Render Waterboxes
    /*const waterBoxes = [
        { xMin: 0,   ySurface: 50, zMin: 0,   xLength: 200, zLength: 150, properties: 0 },
        { xMin: 300, ySurface: 40, zMin: -50, xLength: 100, zLength: 80,  properties: 0 },
    ];*/

    const waterboxCheckbox = document.getElementById('showFullWaterboxDepth');
    
    const waterBoxes = [];
    if (colHeader.waterboxListStart != 0) {
        offset = colHeader.waterboxListStart + address_offset;
        for(let i = 0; i < colHeader.numWaterboxes; i++){
            const xMin = dv.getInt16(offset + i*0x10 + 0x0, endianness);
            const ySurface = dv.getInt16(offset + i*0x10 + 0x2, endianness);
            const zMin = dv.getInt16(offset + i*0x10 + 0x4, endianness); 
            const xLength = dv.getInt16(offset + i*0x10 + 0x6, endianness); 
            const zLength = dv.getInt16(offset + i*0x10 + 0x8, endianness); 
            const properties = dv.getUint32(offset + i*0x10 + 0xC, endianness); 

            waterBoxes.push({xMin: xMin, ySurface: ySurface, zMin: zMin, xLength: xLength, zLength: zLength, properties: properties});
        }
        //console.log(waterBoxes);
        
        const { mesh: waterMesh, edges: waterEdges } = buildWaterBoxModel(waterBoxes, waterboxCheckbox.checked);
        scene.add(waterMesh);
        scene.add(waterEdges);

        loadedModels.push({ name: "Waterboxes", mesh: waterMesh, edges: waterEdges });
        addModelCheckbox(scene, "Waterboxes", waterMesh, waterEdges, false, false, "#00FFFF");
    }

    waterboxCheckbox.addEventListener('change', () => {
        // --- Remove old waterbox mesh & edges ---
        const oldMeshIndex = loadedModels.findIndex(m => m.name === "Waterboxes");
        if (oldMeshIndex >= 0) {
            const old = loadedModels[oldMeshIndex];
            if (old.mesh) {
                scene.remove(old.mesh);
                if (old.mesh.geometry) old.mesh.geometry.dispose();
                if (old.mesh.material) old.mesh.material.dispose();
            }
            if (old.edges) {
                scene.remove(old.edges);
                if (old.edges.geometry) old.edges.geometry.dispose();
                if (old.edges.material) old.edges.material.dispose();
            }
            loadedModels.splice(oldMeshIndex, 1);
        }

        // --- Remove old model checkbox from UI ---
        const container = document.querySelector('.controls'); // adjust if your container is different
        if (container) {
            const oldCheckbox = Array.from(container.children).find(
                child => child.dataset && child.dataset.modelName === "Waterboxes"
            );
            if (oldCheckbox) container.removeChild(oldCheckbox);
        }
        
        // Remove old waterbox mesh & edges
        const oldMesh = loadedModels.find(m => m.name === "WaterboxesMesh");
        if (oldMesh) {
            scene.remove(oldMesh.mesh);
            if (oldMesh.mesh.geometry) oldMesh.mesh.geometry.dispose();
            if (oldMesh.mesh.material) oldMesh.mesh.material.dispose();
            loadedModels.splice(loadedModels.indexOf(oldMesh), 1);
        }

        const oldEdges = loadedModels.find(m => m.name === "WaterboxesEdges");
        if (oldEdges) {
            scene.remove(oldEdges.mesh);
            if (oldEdges.mesh.geometry) oldEdges.mesh.geometry.dispose();
            if (oldEdges.mesh.material) oldEdges.mesh.material.dispose();
            loadedModels.splice(loadedModels.indexOf(oldEdges), 1);
        }

        // Rebuild waterbox model with updated depth
        const { mesh: waterMesh, edges: waterEdges } = buildWaterBoxModel(waterBoxes, waterboxCheckbox.checked);

        // Add both to scene
        scene.add(waterMesh);
        scene.add(waterEdges);

        // Add both to loadedModels for selection, toggles, etc.
        loadedModels.push({ name: "Waterboxes", mesh: waterMesh, edges: waterEdges });
        addModelCheckbox(scene, "Waterboxes", waterMesh, waterEdges, false, false, "#00FFFF");
    });

}

export function parseInvisibleSeams1D(scene, text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && s[0] !== "#");

    const verts = [];      // unique vertices
    const vertMap = new Map(); // map "x,y,z" -> index
    const edges = [];      // pairs of vertex indices

    function getVertIndex(v) {
        const key = v.join(",");
        if (vertMap.has(key)) return vertMap.get(key);
        const idx = verts.length;
        verts.push(v);
        vertMap.set(key, idx);
        return idx;
    }

    for (const l of lines) {
        const parts = l.split(",").map(Number);
        if (parts.length === 6) {
            const v1 = parts.slice(0, 3);
            const v2 = parts.slice(3, 6);
            const i1 = getVertIndex(v1);
            const i2 = getVertIndex(v2);
            edges.push([i1, i2]);
        }
    }

    //console.log(`Model "${name}": ${verts.length} verts, ${edges.length} edges`);
    buildGeometryEdges(scene, verts, edges, "Seams Model", false);
}
