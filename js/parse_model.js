import * as THREE from 'three';
import { addModelCheckbox, buildGeometry, buildGeometry_fwc, buildGeometryFromTriangles, buildGeometryEdges } from './render.js';
import { buildGeometry2, buildGeometry3, buildGeometry4 } from './gap.js';
import { initColCtx, initializeSubdivisions } from './subdivisions.js';
import { renderStandableSurfaceXZ, renderCollisionWallsXY, renderCollisionWallsYZ, renderStandableSurfaceXZ_old } from './standable_surfaces.js';
import { scanAndBuildFlatGroundMarkers, scanAndBuildSpecialNormalMarkers, buildSurfaceTypeMarkers, scanAndBuildSubdivision } from './poly_markers.js';

const wireframeCheckbox = document.getElementById('wireframe');
const surfaceTypeDropdown = document.getElementById("surfaceTypeDropdown");

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
        if (cmd1 == 0x19 && (game == "OOT" || game == "OOT3D")) { // misc_settings
            colHeader.camType = dv.getUint8(current_addr+0x1);
        }
        if (cmd1 == 0x03) { // collision_header
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
                    colHeader.numSurfaceTypes = 200; // there is no numSurfaceTypes in these games, so just get 200 I guess...
                }
                else if (game == "OOT3D") {
                    colHeader.numPolygons = dv.getUint16(cmd2+address_offset+0x0E, endianness);
                    colHeader.numSurfaceTypes = dv.getUint16(cmd2+address_offset+0x10, endianness);
                    colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                    colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
                    colHeader.surfaceTypeListStart = dv.getUint32(cmd2+address_offset+0x20, endianness);
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
                colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
                colHeader.surfaceTypeListStart = dv.getUint32(cmd2+address_offset+0x20, endianness);
            }
            break;
        }
        
        current_addr = current_addr + 0x8;
        cmd1 = dv.getUint8(current_addr);
        cmd2 = dv.getUint32(current_addr+0x4, endianness);
    }
    
    
    let colCtx = initColCtx(game, mapName, colHeader);
    
    console.log("numVtxs: "+colHeader.numVtxs);
    console.log("numPolygons: "+colHeader.numPolygons);
    //console.log("vtxListStart: "+colHeader.vtxListStart);
    //console.log("polygonListStart: "+colHeader.polygonListStart);
    
    // Get SurfaceTypes
    let offset = colHeader.surfaceTypeListStart + address_offset;
    for(let i = 0; i < colHeader.numSurfaceTypes; i++){
        try {
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
        catch {
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
        
        //if (xpFlags & 2) // skip polys that don't have collision
        //    continue;
        
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
    
    const allIdx = [].concat(...tris);
    const maxIdx = Math.max(...allIdx);
    const minIdx = Math.min(...allIdx);
    if(minIdx >= 1 && maxIdx <= verts.length) {
        for(let i = 0; i < tris.length; i++) tris[i]=tris[i].map(x=>x-1);
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
    
    
    /*allTriangleData = [ // test data oot ice cavern wall
        {
                vtxs: [
                        new THREE.Vector3(878,162,-2187),
                        new THREE.Vector3(829,119,-2123),
                        new THREE.Vector3(830,140,-2123)
                ],
                normals: [-26400,1257,-19368],
                d: -592
        }
    ];*/
    
    /*allTriangleData = [ // test data oot ice cavern floor
        { 
                vtxs: [
                        new THREE.Vector3(857,140,-2088),
                        new THREE.Vector3(878,162,-2187),
                        new THREE.Vector3(830,140,-2123)
                ],
                normals: [-7119,31509,5492],
                d: 402
        }
    ];*/
    
    /*allTriangleData = [ // test data oot3d kokiri left
        {
                vtxs: [
                        new THREE.Vector3(-1272, 60, -834),
                        new THREE.Vector3(-1276, 0, -834),
                        new THREE.Vector3(-1115, 1, -841)
                ],
                normals: [1380, -35, 32737],
                d: 886.93
        }
    ];*/
    
    /*allTriangleData = [ // test data oot3d kokiri right
        {
                vtxs: [
                        new THREE.Vector3(-1113, 60, -841),
                        new THREE.Vector3(-1115, 1, -841),
                        new THREE.Vector3(-928, 1, -833)
                ],
                normals: [-1339, 17, 32739],
                d: 794.779
        }
    ];*/
    
    //drawSampledTriangles(scene, allTriangleData, 0.1); // works well for a few, but laggy with multiple triangles
    
    const standableSurfaceMesh = renderStandableSurfaceXZ(allTriangleData);
    if (standableSurfaceMesh) {
        scene.add(standableSurfaceMesh);
        
        standableSurfaceMesh.children[1].visible = wireframeCheckbox.checked;
        if(standableSurfaceMesh.children[3])
            standableSurfaceMesh.children[3].visible = wireframeCheckbox.checked;
        
        loadedModels.push({ name: "Standable Surface", mesh: standableSurfaceMesh, edges: standableSurfaceMesh.children[1] });
        if(standableSurfaceMesh.children[3])
            loadedModels.push({ name: "Standable Surface", mesh: standableSurfaceMesh, edges: standableSurfaceMesh.children[3] });
        
        addModelCheckbox(scene, "Standable Surface", standableSurfaceMesh, null, false, true, "#ff0000");
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
    
    const specialNormalGroup = scanAndBuildSpecialNormalMarkers();
    if (specialNormalGroup) {
        scene.add(specialNormalGroup);
        loadedModels.push({ name: "Special Normal", mesh: specialNormalGroup, edges: null });
        addModelCheckbox(scene, "Special Normal", specialNormalGroup, null, false, false, "#00FFFF");
    }
    
    const subdivisionSelector = document.getElementById("subdivisionSelector");
    subdivisionSelector.max = colCtx.subdivisions.length;
    if (subdivisionSelector.value > colCtx.subdivisions.length)
        subdivisionSelector.value = 0;
    const subdivisionGroup = scanAndBuildSubdivision();
    if (subdivisionGroup) {
        scene.add(subdivisionGroup);
        loadedModels.push({ name: "Subdivision", mesh: subdivisionGroup, edges: null });
        addModelCheckbox(scene, "Subdivision", subdivisionGroup, null, false, false, "#00FFFF");
    }
    
    buildSurfaceTypeMarkers(scene);
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
