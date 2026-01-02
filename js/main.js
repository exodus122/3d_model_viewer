////////////////////////////////////////
// Known Issues:
// - subdivisions are not considered for seams, so points or standable surfaces may be produced which are not actually standable
// - poly exclusion flags (xpflags) were not accounted for when generating the green line seams, 
// so some are fake in lost woods and kokiri
// - Some OoT3D Death mountain crater polys are showing as red standable surfances instead of blue
////////////////////////////////////////

////////////////////////////////////////
// Imports
////////////////////////////////////////

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { updateSamplePointsUIVisibility, drawSampledTriangles } from './sample_points.js';
import { initColCtx, initializeSubdivisions } from './subdivisions.js';
import { renderStandableSurfaceWithEdges, renderStandableSurfaceWithEdges_old } from './standable_surfaces.js';
import { scanAndBuildFlatGroundMarkers, scanAndBuildSpecialNormalMarkers } from './ground_clips.js';
import { performSelection, clearSelection } from './selection.js';


////////////////////////////////////////
// System: DOM / Static UI Elements
////////////////////////////////////////

const mapDropdown = document.getElementById("mapDropdown");
const fileInput = document.getElementById('file');
const loadMapButton = document.getElementById('loadMap');
const wireframeCheckbox = document.getElementById('wireframe');
const gridCheckbox = document.getElementById('grid');
const translucentCheckbox = document.getElementById('translucent');
const opacitySlider = document.getElementById('opacity');
const movementSpeedSlider = document.getElementById('movementSpeedSlider');
const backfaceCheckbox = document.getElementById('backface');
const camPosEl = document.getElementById('cam-pos');
const camRotEl = document.getElementById('cam-rot');
const statusEl = document.getElementById('status');
const controlModeSel = document.getElementById('control-mode');
const gameSel = document.getElementById('selected-game');

const display_fwc = document.getElementById('display_fwc');
const display_fwc_label = document.getElementById('display_fwc_label');

////////////////////////////////////////
// System: Scene, Renderer, Camera, Lights
////////////////////////////////////////
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);

const camera = new THREE.PerspectiveCamera(60,2,0.1,100000);
camera.position.set(0,100,400);

// Lights
const hemi = new THREE.HemisphereLight(0xaaaaee,0xaaaaee,0.8); // 0x9696fa
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff,0.7);
dir.position.set(100,200,100);
scene.add(dir);

// Material used as base for clones per mesh
const material = new THREE.MeshStandardMaterial({color:0x3aa6ff,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
const material2 = new THREE.MeshStandardMaterial({color:0xf56342,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
const material3 = new THREE.MeshStandardMaterial({color:0xe1eb34,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});

////////////////////////////////////////
// System: UI wiring (material/grid/wireframe/pointer status/etc)
////////////////////////////////////////

const grid = new THREE.GridHelper(8000, 80, '#1c2a3a', '#0f1720');
grid.material.opacity = 0.25;
grid.material.transparent = true;
grid.visible = gridCheckbox.checked;
scene.add(grid);

function setStatus(msg, level='info'){
    statusEl.textContent = `Status: ${msg}`;
    if(level==='warn') statusEl.style.background = '#40230b';
    else if(level==='error') statusEl.style.background = '#4b0b0b';
    else statusEl.style.background = '#221a11';
}

function setMaterialProps() {
    loadedModels.forEach(m => {
        if (m.mesh && m.mesh.material) {
            m.mesh.material.transparent = translucentCheckbox.checked;
            m.mesh.material.opacity = parseFloat(opacitySlider.value);
            m.mesh.material.side = backfaceCheckbox.checked
                ? THREE.DoubleSide
                : THREE.FrontSide;
            m.mesh.material.needsUpdate = true;
        }
    });
}

translucentCheckbox.addEventListener('change', setMaterialProps);
opacitySlider.addEventListener('input', setMaterialProps);
backfaceCheckbox.addEventListener('change', setMaterialProps);

movementSpeedSlider.addEventListener('input', () => {speed = movementSpeedSlider.value;});

wireframeCheckbox.addEventListener('change', () => {
    loadedModels.forEach(m => {
        if (m.edges) {
            m.edges.visible = m.mesh.visible && wireframeCheckbox.checked;
        }
    });
});

gridCheckbox.addEventListener('change', () => {
    grid.visible = gridCheckbox.checked;
});


////////////////////////////////////////
// System: Dropdown population (initial)
////////////////////////////////////////

BK_Maps.forEach(map => {
    const option = document.createElement("option");
    option.value = map.name; // This will be the value when selected
    option.textContent = map.name; // This is what’s shown to the user
    mapDropdown.appendChild(option);
});

////////////////////////////////////////
// System: Game selector
////////////////////////////////////////

gameSel.addEventListener('change',(e)=>{
    game = e.target.value;
    mapDropdown.options.length = 0;
    
    let maps = GAME_MAPS[game]
    
    if(game == "OOT" || game == "MM") {
            EPS = 0.008;
    }
    else if(game == "OOT3D" || game == "MM3D") {
            EPS = 0.00008;
    }
    
    maps.forEach(map => {
        const option = document.createElement("option");
        option.value = map.name; // This will be the value when selected
        option.textContent = map.name; // This is what’s shown to the user
        mapDropdown.appendChild(option);
    });
    
    if (game == "BK" || game == "BT")
        display_fwc_label.style.display = "none";
    else
        display_fwc_label.style.display = "block";
        
});

////////////////////////////////////////
// System: Load Map button
////////////////////////////////////////

// Get map property
function getMapProperty(game, mapName, prop) {
    const maps = GAME_MAPS[game];
    if (!maps) return null;

    const found = maps.find(map => map.name === mapName);
    return found ? found[prop] ?? null : null;
}

// Load selected map
loadMap.addEventListener('click', async (e) => {
    const game = document.getElementById("selected-game").value;
    
    if (game == "BK" || game == "BT"){
        
        const mapName = document.getElementById("mapDropdown").value;
        let mapFilename = getMapProperty(game, mapName, "modelAPointer");
        let mapFilename2 = getMapProperty(game, mapName, "modelBPointer");

        try {
            const res1 = await fetch('./models/' + game + '/' + mapFilename);
            const buffer1 = await res1.arrayBuffer();
            console.log(mapFilename+": Binary file length:", buffer1.byteLength);
            parseBKModelBinary(buffer1, true);

            if (mapFilename2 === undefined) {
            
            }
            else {
                const res2 = await fetch('./models/' + game + '/' + mapFilename2);
                const buffer2 = await res2.arrayBuffer();
                console.log(mapFilename2+": Binary file length:", buffer2.byteLength);
                parseBKModelBinary(buffer2, false);
            }
        } catch (err) {
            console.error(err);
        }
    }
    else if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D"){
        const mapName = document.getElementById("mapDropdown").value;
        let mapFilename = getMapProperty(game, mapName, "file");

        try {
            const res1 = await fetch('./models/' + game + '/' + mapFilename);
            const buffer1 = await res1.arrayBuffer();
            console.log(mapFilename+": Binary file length:", buffer1.byteLength);
            parseZeldaModelBinary(buffer1, true, mapName);
            
            if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") {
                let mapFilename2 = getMapProperty(game, mapName, "seams");
                if (mapFilename2 === undefined) {
                
                }
                else {
                    let seams_path = "seams";
                    if (game == "OOT3D" || game == "MM3D" || game == "MM" || game == "OOT")
                        seams_path = "seams2";
                    const res2 = await fetch('./models/' + game + '/' + seams_path + '/' + mapFilename2);
                    //const res2 = await fetch('./models/' + game + '/' + seams_path + '/' + "test.txt");
                        
                    const buffer2 = await res2.arrayBuffer();
                    console.log(mapFilename2+": Binary file length:", buffer2.byteLength);
                    
                    parseInvisibleSeams1D(new TextDecoder().decode(buffer2));
                }
            }
        } catch (err) {
            console.error(err);
        }
    }
});

////////////////////////////////////////
// System: File input (user-supplied file)
////////////////////////////////////////

// File parsing
fileInput.addEventListener('change', async (ev)=>{
    const f = ev.target.files[0];
    if(!f) return;
    const buf = await f.arrayBuffer();
    parseModel(buf);
});

////////////////////////////////////////
// System: Model Parsing (text vs binary dispatch)
////////////////////////////////////////

// Detect binary vs text simple heuristic
function parseModel(buffer){
    if(typeof buffer === 'string') { parseInvisibleSeams1D(buffer); return; }
    const uint8 = new Uint8Array(buffer);
    let isText = true;
    for(let i=0;i<Math.min(64,uint8.length);i++){
        const c = uint8[i];
        if(c===9||c===10||c===13) continue;
        if(c<32 || c>126){ isText=false; break; }
    }
    if(isText && (game == "OOT" || game == "MM")) parseZeldaModelTextTriangles(new TextDecoder().decode(buffer), true);
    else if(isText) parseInvisibleSeams1D(new TextDecoder().decode(buffer));
    else {
        if(game == "BK" || game == "BT")
                parseBKModelBinary(buffer, true);
        else if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D")
                parseZeldaModelBinary(buffer, true, "");
        else
                parseModelBinary(buffer);
    }
}

// Text format: lines with "v x y z" and "f i j k" (1-based or 0-based)
function parseModelText(text){
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
    buildGeometry(verts, tris, null, "Main Model", true);
}

// Binary format: [uint16 vertexCount][uint16 triCount] then vertexCount*(int16 x,y,z) then triCount*(uint16 a,b,c)
function parseModelBinary(buffer){
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
    buildGeometry(verts, tris, null, "Main Model", true);
}

function parseBKModelBinary(buffer, fresh){
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
    
    buildGeometry(verts, tris, null, modelName, fresh);
}

function parseZeldaModelTextTriangles(text, fresh) {
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
        buildGeometry_fwc(verts, tris, null, modelName, fresh);
    else
        buildGeometry(verts, tris, null, modelName, fresh);
}

function parseZeldaModelBinary(buffer, fresh, mapName){

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
                }
                else if (game == "OOT3D") {
                    colHeader.numPolygons = dv.getUint16(cmd2+address_offset+0x0E, endianness);
                    colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                    colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
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
                colHeader.vtxListStart = dv.getUint32(cmd2+address_offset+0x18, endianness);
                colHeader.polygonListStart = dv.getUint32(cmd2+address_offset+0x1C, endianness);
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
    
    const verts = [];
    let offset = colHeader.vtxListStart + address_offset;
    for(let i = 0; i < colHeader.numVtxs; i++){
        const x = dv.getInt16(offset + i*6 + 0x0, endianness);
        const y = dv.getInt16(offset + i*6 + 0x2, endianness);
        const z = dv.getInt16(offset + i*6 + 0x4, endianness); 

        verts.push([x, y, z]);
    }
    //console.log(verts);
    
    const tris = [];
    offset = colHeader.polygonListStart + address_offset;
    for(let i = 0; i < colHeader.numPolygons; i++){
        if(offset+poly_length > dv.byteLength) break;
        
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
        
        if (xpFlags & 2) // skip polys that don't have collision
                continue;
        
        tris.push([a+1,b+1,c+1]);
        
        // --- Build triangle object directly for allTriangleData ---
        const vtxs = [
                new THREE.Vector3(verts[a][0], verts[a][1], verts[a][2]),
                new THREE.Vector3(verts[b][0], verts[b][1], verts[b][2]),
                new THREE.Vector3(verts[c][0], verts[c][1], verts[c][2])
        ];

        allTriangleData.push({
                id: i,
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
        buildGeometry_fwc(verts, tris, modelName, fresh);
    else
        buildGeometry(verts, tris, allTriangleData, modelName, fresh);
    
    
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
    
    //drawSampledTriangles(scene, allTriangleData, 0.1); // WORKS WELL for a few, but laggy with multiple triangles
    
    const standableSurfaceMesh = renderStandableSurfaceWithEdges(allTriangleData);
    if (standableSurfaceMesh) {
        scene.add(standableSurfaceMesh);
        loadedModels.push({ name: "Standable Surface", mesh: standableSurfaceMesh, edges: null });
        addModelCheckbox("Standable Surface", standableSurfaceMesh, null, false, true, "#ff0000");
    }
    
    const flatGroup = scanAndBuildFlatGroundMarkers();
    if (flatGroup) {
        scene.add(flatGroup);
        loadedModels.push({ name: "Flat Ground Clips", mesh: flatGroup, edges: null });
        addModelCheckbox("Flat Ground Clips", flatGroup, null, false, false, "#00FFFF");
    }
    
    const specialNormalGroup = scanAndBuildSpecialNormalMarkers();
    if (specialNormalGroup) {
        scene.add(specialNormalGroup);
        loadedModels.push({ name: "Special Normal", mesh: specialNormalGroup, edges: null });
        addModelCheckbox("Special Normal", specialNormalGroup, null, false, false, "#00FFFF");
    }
}

function parseInvisibleSeams1D(text) {
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
    buildGeometryEdges(verts, edges, "Seams Model", false);
}

////////////////////////////////////////
// System: Geometry creation
////////////////////////////////////////

function buildGeometry(verts, tris, allTriangleData, name = "Main Model", clearFirst = true) {
    
    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) { 
        alert('No valid vertices or triangles found'); 
        return; 
    }

    // Optionally clear all existing models
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels = [];
        loadedModels2.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels2 = [];

        // Remove all model checkboxes
        removeAllModelCheckboxes();
        
        // Clear selection
        clearSelection(scene);
    }

    // Create vertex positions
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3 * i]     = verts[i][0];
        positions[3 * i + 1] = verts[i][1];
        positions[3 * i + 2] = verts[i][2];
    }

    // Create triangle indices
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[3 * i]     = tris[i][0];
        indices[3 * i + 1] = tris[i][1];
        indices[3 * i + 2] = tris[i][2];
    }

    // Build geometry and mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;  // Store metadata
    if(!clearFirst)
        meshObj.material.color.set(0x3aff78);
    scene.add(meshObj);

    // Build wireframe edges
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const va = verts[a], vb = verts[b], vc = verts[c];
        edgePositions.push(
            va[0], va[1], va[2], vb[0], vb[1], vb[2],
            vb[0], vb[1], vb[2], vc[0], vc[1], vc[2],
            vc[0], vc[1], vc[2], va[0], va[1], va[2]
        );
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: 0x3240a8, linewidth: 1, opacity: 0.8, transparent: true }) // 3240a8
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Store and register in UI
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    //console.log(loadedModels);
    addModelCheckbox(name, meshObj, edgesObj, clearFirst, true);
    
    updateSamplePointsUIVisibility(game);
}

function buildGeometry_fwc(verts, tris, name = "Main Model", clearFirst = true) {

    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) {
        alert('No valid vertices or triangles found');
        return;
    }

    // Clear existing models
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels = [];

        loadedModels2.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels2 = [];

        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // Build vertex buffer
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[i * 3 + 0] = verts[i][0];
        positions[i * 3 + 1] = verts[i][1];
        positions[i * 3 + 2] = verts[i][2];
    }

    // Build index buffer
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[i * 3 + 0] = tris[i][0];
        indices[i * 3 + 1] = tris[i][1];
        indices[i * 3 + 2] = tris[i][2];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.clearGroups();

    // --- normal.y helper ---
    function triangleNormalY(a, b, c) {
        const ax = b[0] - a[0];
        const ay = b[1] - a[1];
        const az = b[2] - a[2];

        const bx = c[0] - a[0];
        const by = c[1] - a[1];
        const bz = c[2] - a[2];

        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return ny / len;
    }

    // --- build geometry groups ---
    let groupStart = 0;
    let currentGroup = null;

    for (let i = 0; i < tris.length; i++) {
        const [ia, ib, ic] = tris[i];
        const ny = triangleNormalY(verts[ia], verts[ib], verts[ic]);

        let group;
        if (ny > 0.5) {
            group = 0;          // floor
        } else if (ny < -0.8) {
            group = 2;          // ceiling
        } else {
            group = 1;          // wall
        }

        if (currentGroup === null) {
            currentGroup = group;
            groupStart = i * 3;
        }

        if (group !== currentGroup) {
            geom.addGroup(groupStart, (i * 3) - groupStart, currentGroup);
            groupStart = i * 3;
            currentGroup = group;
        }
    }

    // flush final group
    geom.addGroup(groupStart, tris.length * 3 - groupStart, currentGroup);

    // --- mesh ---
    const meshObj = new THREE.Mesh(
        geom,
        [
            material.clone(),   // group 0
            material2.clone(),  // group 1
            material3.clone()   // group 2
        ]
    );

    meshObj.material.forEach(m => {
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
    });

    if (!clearFirst) {
        meshObj.material.forEach(m => m.color.set(0x3aff78));
    }

    scene.add(meshObj);

    // --- wireframe edges ---
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const va = verts[a], vb = verts[b], vc = verts[c];
        edgePositions.push(
            va[0], va[1], va[2], vb[0], vb[1], vb[2],
            vb[0], vb[1], vb[2], vc[0], vc[1], vc[2],
            vc[0], vc[1], vc[2], va[0], va[1], va[2]
        );
    }

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({
            color: 0x3240a8,
            linewidth: 1,
            opacity: 0.8,
            transparent: true
        })
    );

    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Register model
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    addModelCheckbox(name, meshObj, edgesObj, clearFirst, true);
    
    updateSamplePointsUIVisibility(game);
}

function buildGeometryFromTriangles(allTriangleData, name = "Main Model", clearFirst = true) {

    if ((!allTriangleData || allTriangleData.length === 0) && clearFirst) {
        alert("No triangle data found");
        return;
    }

    // ---------------------
    // Optional: Clear scene
    // ---------------------
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels = [];

        loadedModels2.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
        });
        loadedModels2 = [];

        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // ---------------------
    // Build position buffer
    // ---------------------
    const positions = new Float32Array(allTriangleData.length * 9); // 3 verts × 3 floats
    const indices   = new (allTriangleData.length > 21845 ? Uint32Array : Uint16Array)(allTriangleData.length * 3);

    let pi = 0;
    for (let i = 0; i < allTriangleData.length; i++) {
        const tri = allTriangleData[i];
        const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];

        positions[pi++] = v0.x; positions[pi++] = v0.y; positions[pi++] = v0.z;
        positions[pi++] = v1.x; positions[pi++] = v1.y; positions[pi++] = v1.z;
        positions[pi++] = v2.x; positions[pi++] = v2.y; positions[pi++] = v2.z;

        const base = i * 3;
        indices[base]     = base;
        indices[base + 1] = base + 1;
        indices[base + 2] = base + 2;
    }

    // ---------------------
    // Build geometry object
    // ---------------------
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    // Three’s normals are lighting normals. Not what you want for OOT plane normals.
    // But we let Three compute them anyway for shading.
    geom.computeVertexNormals();

    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    if (!clearFirst)
        meshObj.material.color.set(0x3aff78);

    // Store original triangle metadata here
    meshObj.userData.allTriangleData = allTriangleData;

    scene.add(meshObj);

    // ---------------------
    // Wireframe edges
    // ---------------------
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i+1], c = indices[i+2];
        const pa = new THREE.Vector3(
            positions[3*a], positions[3*a+1], positions[3*a+2]
        );
        const pb = new THREE.Vector3(
            positions[3*b], positions[3*b+1], positions[3*b+2]
        );
        const pc = new THREE.Vector3(
            positions[3*c], positions[3*c+1], positions[3*c+2]
        );

        edgePositions.push(
            pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
            pb.x, pb.y, pb.z, pc.x, pc.y, pc.z,
            pc.x, pc.y, pc.z, pa.x, pa.y, pa.z
        );
    }

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({
            color: 0x3240a8,
            linewidth: 1,
            opacity: 0.8,
            transparent: true
        })
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Register in UI
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    addModelCheckbox(name, meshObj, edgesObj, clearFirst, true);

    updateSamplePointsUIVisibility(game);
}

function buildGeometryEdges(verts, edges, name = "Edge Model", clearFirst = true) {

    if ((!verts || !edges || verts.length === 0 || edges.length === 0) && clearFirst) {
        alert('No valid vertices or edges found');
        return;
    }

    // Clear existing models
    if (clearFirst) {
        loadedModels.forEach(m => {
            if(m.mesh) scene.remove(m.mesh);
            if(m.edges) scene.remove(m.edges);
        });
        loadedModels = [];
        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // Flatten edge positions (original logic)
    const edgePositions = [];
    for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i];
        const va = verts[a];
        const vb = verts[b];
        edgePositions.push(
            va[0], va[1], va[2],
            vb[0], vb[1], vb[2]
        );
    }

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

    // Improve visibility
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({
            color: 0x00ff00,   // green
            linewidth: 1,   // thickness in world units
            transparent: false,
            opacity: 0.8,
            depthTest: true
        })
    );

    edgesObj.visible = true;
    scene.add(edgesObj);

    loadedModels.push({ name, mesh: null, edges: edgesObj });

    // Register in UI
    addModelCheckbox(name, null, edgesObj, clearFirst, true);
}

////////////////////////////////////////
// System: Model checkboxes
////////////////////////////////////////

function removeAllModelCheckboxes() {
    const section = document.querySelector('.controls');
    // Remove all containers that hold the model checkbox + color picker
    section.querySelectorAll('div').forEach(container => {
        const label = container.querySelector('label');
        if (label && label.textContent.trim().startsWith('Show ')) {
            container.remove();
        }
    });
}

function addModelCheckbox(name, meshObj, edgesObj, clearFirst, checked, color = null, deleteButton = false) {
    const section = document.querySelector('.controls');

    // Container
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.marginBottom = '4px';
    container.style.gap = '8px'; // space between checkbox+label and color picker
    container.dataset.modelName = name;

    // Visibility checkbox + label
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = checked;
    if (meshObj != null)
        meshObj.visible = checked;
    if (edgesObj != null)
        edgesObj.visible = checked;
    chk.addEventListener('change', () => {
        if (meshObj != null)
            meshObj.visible = chk.checked;
        if (edgesObj != null)
            edgesObj.visible = chk.checked && wireframeCheckbox.checked;
        clearSelection(scene);
    });
    label.appendChild(chk);
    const labelText = document.createTextNode(` Show ${name}`);
    label.appendChild(labelText);
    
    // ----- DELETE BUTTON -----
    const del = document.createElement('button');
    del.textContent = "×";
    del.style.marginLeft = "4px";
    del.style.cursor = "pointer";
    del.style.padding = "0 4px";
    del.style.border = "1px solid #888";
    del.style.borderRadius = "3px";
    del.style.background = "#333";
    del.style.color = "#f55";
    del.title = "Remove this model";
    del.classList.add("delete-btn");
    
    del.addEventListener('click', () => {
        // Remove from scene
        if (meshObj) scene.remove(meshObj);
        if (edgesObj) scene.remove(edgesObj);

        // Dispose
        if (meshObj?.geometry) meshObj.geometry.dispose();
        if (meshObj?.material) meshObj.material.dispose();
        if (edgesObj?.geometry) edgesObj.geometry.dispose();
        if (edgesObj?.material) edgesObj.material.dispose();

        // Remove from loadedModels
        const idx = loadedModels.findIndex(m => m.name === name);
        if (idx !== -1) loadedModels.splice(idx, 1);

        // Remove UI
        container.remove();

        clearSelection(scene);
        updateSelectionUI();
    });

    // Color picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    if (color != null)
        colorInput.value = color;
    else
        colorInput.value = clearFirst ? '#3aa6ff' : '#3aff78';
    colorInput.addEventListener('input', () => {
        if (meshObj != null && meshObj.material) {
            meshObj.material.color.set(colorInput.value);
            meshObj.material.needsUpdate = true;
        }
        else if (meshObj != null && meshObj.children) {
            meshObj.children[0].material.color.set(colorInput.value);
            meshObj.children[0].material.needsUpdate = true;    
        }
        else if (edgesObj != null && edgesObj.material) {
            edgesObj.material.color.set(colorInput.value);
            edgesObj.material.needsUpdate = true;
        }
    });

    // Assemble
    container.appendChild(label);
    container.appendChild(colorInput);
    if(deleteButton) {
        container.appendChild(del);
    }
    section.appendChild(container);
}

////////////////////////////////////////
// System: Canvas / Pointer interactions
////////////////////////////////////////
const pointerControls = new PointerLockControls(camera, renderer.domElement);

renderer.domElement.addEventListener('click', (ev)=>{
    // If user explicitly selected Orbit mode, always treat click as selection (no pointer lock)
    if(controlMode === 'orbit'){
        let pts = performSelection(ev, renderer, camera, scene);
        if (pts)
            addModelCheckbox("Points", pts, null, false, true, "#ff0000", true);
        return;
    }

    // If pointer already locked on our canvas, treat click as selection
    if(document.pointerLockElement === renderer.domElement){
        let pts = performSelection(ev, renderer, camera, scene);
        if (pts)
            addModelCheckbox("Points", pts, null, false, true, "#ff0000", true);
        return;
    }

    // If user chose Pointer mode or Auto, try to acquire pointer lock on canvas
    if(controlMode === 'pointer' /*|| controlMode === 'auto'*/){
        try{
            // Attempt to lock; this may throw in sandboxed frames.
            pointerControls.lock();
            setStatus('requesting mouse lock...');
        }catch(err){
            // SecurityError when iframe sandbox blocks pointer lock
            console.warn('Mouse lock request failed:', err);
            pointerLockBlocked = true;
            //setStatus('Mouse lock blocked (sandbox or permission). Falling back to orbit controls.', 'warn');
            //enableOrbitControls();
        }
    }
});

// Listen for pointerlockchange/pointerlockerror to update status
document.addEventListener('pointerlockchange', ()=>{
    if(document.pointerLockElement === renderer.domElement){
        setStatus('Mouse locked. WASD to fly. Click again to select triangles. Press Esc to unlock.');
    } else {
        setStatus('Mouse unlocked.');
    }
});

document.addEventListener('pointerlockerror', (ev)=>{
    console.warn('pointerlockerror', ev);
    pointerLockBlocked = true;
    //setStatus('Mouse lock error — falling back to orbit controls.', 'error');
    //enableOrbitControls();
});

// Control mode selector
controlModeSel.addEventListener('change',(e)=>{
    controlMode = e.target.value;
    if(controlMode === 'orbit'){
        enableOrbitControls();
    }else if(controlMode === 'pointer'){
        // try to exit orbit and enable pointer behavior
        disableOrbitControls();
        setStatus('Fly mode selected. Click the canvas to request mouse lock.');
    }else{ // auto
        if(pointerLockBlocked){
            enableOrbitControls();
        } else {
            disableOrbitControls();
            setStatus('Auto mode: click canvas to request mouse lock.');
        }
    }
});

function onWindowResize(){
    const w = renderer.domElement.clientWidth || window.innerWidth - 320;
    const h = renderer.domElement.clientHeight || window.innerHeight;
    if(h===0 || w===0) return;
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    renderer.setSize(w,h,false);
}
window.addEventListener('resize', onWindowResize);

////////////////////////////////////////
// System: Fly/Orbit controls
////////////////////////////////////////

function enableOrbitControls(){
    if(orbitControls) return;
    try{
        if(document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    }catch(e){ console.warn('exitPointerLock failed', e); }
    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.screenSpacePanning = false;
    orbitControls.enablePan = true;
    
    // Hide crosshair in orbit mode
    if (crosshair) crosshair.style.display = 'none';
    if (hint) hint.style.display = 'none';
    
    setStatus('Orbit controls active (drag to rotate, scroll to zoom).');
}

function disableOrbitControls(){
    if(!orbitControls) return;
    orbitControls.dispose();
    orbitControls = null;
    
    // Show crosshair in fly mode
    if (crosshair) crosshair.style.display = 'block';
    if (hint) hint.style.display = 'block';
    
    setStatus('Orbit controls disabled.');
}

// Movement keyboard (only affects pointer-lock / fly mode)
document.addEventListener('keydown',(e)=>{
    if(e.code==='KeyW') move.forward=true;
    if(e.code==='KeyS') move.back=true;
    if(e.code==='KeyA') move.left=true;
    if(e.code==='KeyD') move.right=true;
    if(e.code==='Space') move.up=true;
    if(e.code==='KeyC') move.down=true;
});
document.addEventListener('keyup',(e)=>{
    if(e.code==='KeyW') move.forward=false;
    if(e.code==='KeyS') move.back=false;
    if(e.code==='KeyA') move.left=false;
    if(e.code==='KeyD') move.right=false;
    if(e.code==='Space') move.up=false;
    if(e.code==='KeyC') move.down=false;
});

////////////////////////////////////////
// System: Rendering loop
////////////////////////////////////////

let last = performance.now();

function animate(){
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05,(now-last)/1000);
    last = now;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));

    if(controlMode !== 'orbit' && document.pointerLockElement === renderer.domElement){
        // Apply WASD movement in pointer-lock mode
        const dir = new THREE.Vector3();
        if(move.forward) dir.z -= 1;
        if(move.back) dir.z += 1;
        if(move.left) dir.x -= 1;
        if(move.right) dir.x += 1;
        if(move.up) dir.y += 1;
        if(move.down) dir.y -= 1;
        if(dir.lengthSq()>0){
            dir.normalize();
            const worldDir = dir.applyQuaternion(camera.quaternion).multiplyScalar(speed*dt);
            pointerControls.getObject().position.add(worldDir);
            camera.position.copy(pointerControls.getObject().position);
        }
    }

    // Update UI
    camPosEl.textContent = `${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}`;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion);
    camRotEl.textContent = `${THREE.MathUtils.radToDeg(euler.x).toFixed(1)}, ${THREE.MathUtils.radToDeg(euler.y).toFixed(1)}, ${THREE.MathUtils.radToDeg(euler.z).toFixed(1)}`;

    // Update orbit controls if active
    if(orbitControls) orbitControls.update();

    // update edges transformation if any
    if(edges && mesh){ edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); }

    renderer.render(scene,camera);
}
onWindowResize();
animate();

////////////////////////////////////////
// System: Test model & dev helpers
////////////////////////////////////////

// initial scene: build a small test cube if user hasn't loaded
function buildTest(){
    const verts = [[-200,-200,-200],[200,-200,-200],[200,200,-200],[-200,200,-200],[-200,-200,200],[200,-200,200],[200,200,200],[-200,200,200]];
    const tris = [[0,1,2],[0,2,3],[4,7,6],[4,6,5],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
    buildGeometry(verts, tris, null, "Main Model", true);
}
buildTest();

// expose a tiny helpful function on window for quick testing
window.__3dv = { parseModelText, parseModelBinary };

////////////////////////////////////////
// System: Initialization checks
////////////////////////////////////////

// Initial status: determine starting mode
(function initStatus(){
    // If the environment is clearly sandboxed (iframe), we cannot reliably request pointer lock.
    try{
        // Some browsers throw immediately when calling requestPointerLock in a sandbox; we don't call it here — just detect availability.
        const supported = 'requestPointerLock' in Element.prototype;
        if(!supported){ pointerLockBlocked = true; setStatus('Pointer lock not supported in this environment; orbit controls enabled.', 'warn'); enableOrbitControls(); return; }
        setStatus('Ready. Click canvas to request mouse lock (Auto).');
    }catch(e){
        pointerLockBlocked = true;
        setStatus('Mouse lock appears unavailable; orbit controls enabled.', 'warn');
        enableOrbitControls();
    }
})();
