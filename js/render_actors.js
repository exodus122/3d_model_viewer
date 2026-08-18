import * as THREE from 'three';
import { addModelCheckbox, buildGeometry, buildGeometry_fwc, clearAllModels, buildGeometryButDontAddToScene, getModelGroup, primaryColorTarget, resetGroupModelState } from './render.js';
import { parseCollisionHeader, parseVerticesAndPolygons, parseWaterboxes } from './parse_model.js';
import { dynaTransformVertices, dynaRecomputePolyData, dynaActorPos } from './dyna_transform.js';
import { buildWaterBoxModel } from './waterboxes.js';
import { renderStandableSurfaceXZ, STANDABLE_DET_MAX_DYNAPOLY } from './standable_surfaces.js';

const wireframeCheckbox = document.getElementById('wireframe');
const surfaceTypeDropdown = document.getElementById("surfaceTypeDropdown");
const groundClipBandsCheckbox = document.getElementById('groundClipBandsCheckbox');
const waterboxCheckbox = document.getElementById('showFullWaterboxDepth');

function parseZeldaObjectBinary(scene, buffer, fresh, actorName, objectName, colHeaderAddr, verts, tris, allTriangleData, intangibleTris, intangibleTriangleData, waterBoxes){

    const dv = new DataView(buffer);
    if (dv.byteLength < 4) {
        alert('binary too small');
        return;
    }
    
    let endianness = false;
    let current_addr = 0x0;
    let address_offset = 0x0;
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
    colHeader.surfaceTypes = [];
    
    colHeaderAddr = colHeaderAddr & 0x00FFFFFF;
    parseCollisionHeader(dv, colHeaderAddr, address_offset, colHeader, endianness);
    colHeader.vtxListStart &= 0x00FFFFFF;
    colHeader.polygonListStart &= 0x00FFFFFF;
    colHeader.surfaceTypeListStart &= 0x00FFFFFF;
    colHeader.waterboxListStart &= 0x00FFFFFF;
    
    parseVerticesAndPolygons(dv, colHeader, address_offset, endianness, poly_length, verts, tris, intangibleTris, intangibleTriangleData, allTriangleData);

    parseWaterboxes(dv, colHeader, address_offset, endianness, waterBoxes);

    //console.log(game+" - "+objectName+" - numVtxs: "+colHeader.numVtxs+", numPolygons: "+colHeader.numPolygons
    //    +", numTangible: "+tris.length+", numIntangible: "+intangibleTris.length+", numWaterBoxes: "+waterBoxes.length);

}

export function renderZeldaObjectBinary(scene, buffer, fresh, actorName, objectName, colHeaderAddr){
    let verts = [];
    let tris = [];
    let allTriangleData = [];
    let intangibleTris = [];
    let intangibleTriangleData = [];
    let waterBoxes = [];

    parseZeldaObjectBinary(scene, buffer, fresh, actorName, objectName, colHeaderAddr, verts, tris, allTriangleData, intangibleTris, intangibleTriangleData, waterBoxes)

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

    let hasCollision = false;
    
    if (tris.length > 0) {
        if (display_fwc.checked)
            buildGeometry_fwc(scene, verts, tris, modelName, fresh);
        else
            buildGeometry(scene, verts, tris, allTriangleData, null, modelName, fresh);
        hasCollision = true;
    }
    if (intangibleTris.length > 0) {
        buildGeometry(scene, verts, intangibleTris, intangibleTriangleData, null, "Intangible Collision", !hasCollision, !hasCollision, 0x3aff78);
        hasCollision = true;
    }
    if (waterBoxes.length > 0) {
        if(!hasCollision) {
            clearAllModels(scene);
        }

        const { mesh: waterMesh, edges: waterEdges } = buildWaterBoxModel(waterBoxes, waterboxCheckbox.checked);
        scene.add(waterMesh);
        scene.add(waterEdges);
        loadedModels.push({ name: "Waterboxes", mesh: waterMesh, edges: waterEdges });
        addModelCheckbox(scene, "Waterboxes", waterMesh, waterEdges, false, true, "#00FFFF");
        hasCollision = true;

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
    if(!hasCollision) {
        clearAllModels(scene);
        alert('No valid vertices, triangles, or waterboxes found'); 
    }
}

async function fetchJSON(path) {
  try {
    // 1. Request the file path from your server
    const response = await fetch(path);
    
    // 2. Read the stream and automatically parse it as JSON
    const parsedObject = await response.json();

    return parsedObject;
  } catch (error) {
    console.error('Failed to fetch or parse JSON:', error);
  }
}

// ------------------------------------------------------------------
// Scene actor-entry (spawn list) decoding
// ------------------------------------------------------------------
// An ActorEntry is 0x10 bytes in both games:
//     s16 id; Vec3s pos; Vec3s rot; s16 params;
//
// OOT passes the entry through untouched -- Actor_SpawnEntry (z_actor.c)
// is just a forwarding call, so rot.x/y/z are plain 16-bit binangs:
//     Actor_Spawn(..., entry->rot.x, entry->rot.y, entry->rot.z, entry->params)
//
// MM does NOT. Actor_SpawnEntry (z_actor.c) splits every rotation word at
// bit 7 and packs three extra fields into the low bits:
//
//     rotX = (rot.x >> 7) & 0x1FF   bits 2-0 -> halfDaysBits 9..7
//     rotY = (rot.y >> 7) & 0x1FF   bits 6-0 -> csId (0x7F == CS_ID_NONE)
//     rotZ = (rot.z >> 7) & 0x1FF   bits 6-0 -> halfDaysBits 6..0
//
//     csId         =   rot.y & 0x7F
//     halfDaysBits = ((rot.x & 7) << 7) | (rot.z & 0x7F)   // 0 means "all"
//
// Bits 6-3 of rot.x are unused (verified: zero for all 5826 entries in
// MM_actors_by_scene.json). ZAPD writes the pair back out as
// SPAWN_ROT_FLAGS(rot, flags) = (rot << 7) | flags, which is where the
// packed words in the JSON come from.
//
// The surviving 9-bit rotation field is in DEGREES (0-511), not binang, so
// it has to go through DEG_TO_BINANG before it can be fed to the
// SkinMatrix code -- unless the matching flag in the id word says the field
// is raw actor params rather than a rotation.
const ACTOR_ENTRY_ID_MASK      = 0x1FFF; // MM: Actor_SpawnEntry masks the id
const ACTOR_ENTRY_ROTY_IS_RAW  = 0x8000;
const ACTOR_ENTRY_ROTX_IS_RAW  = 0x4000;
const ACTOR_ENTRY_ROTZ_IS_RAW  = 0x2000;

// MM retail scenes DO set those id flags -- ZAPD writes them out as e.g.
//     { ACTOR_EN_BOX | 0x6000, ... }   (KAKUSIANA_room_07.c, Z2_INISIE_N_room_00.c)
//     { ACTOR_OBJ_TSUBO | 0x2000, ... }
// but MM_actors_by_scene.json stores the id already masked, so the flags are
// gone by the time they reach us (all 5826 entries have bits 15-13 clear).
//
// The flag is set PER ENTRY, not per actor type. Every En_Box happens to
// carry 0x6000, but Bg_Hakugin_Post does not: Z2_HAKUGIN_room_04.c places
// eight of them and only the one that uses rot.x/rot.z as switch flags is
// written as `ACTOR_BG_HAKUGIN_POST | 0x6000` -- the other seven are bare.
//
// So this table is an approximation, safe only because an unflagged entry
// of a listed actor has a zero rotation field, where the raw and degree
// paths agree. The real fix is to stop masking the id when generating the
// JSON; the table is only consulted when the entry carries no flags of its
// own, so a regenerated JSON silently takes over.
const MM_ACTOR_ENTRY_ID_FLAGS = {
    0x006: ACTOR_ENTRY_ROTX_IS_RAW | ACTOR_ENTRY_ROTZ_IS_RAW, // En_Box (0x6000)
    0x18F: ACTOR_ENTRY_ROTX_IS_RAW | ACTOR_ENTRY_ROTZ_IS_RAW, // Bg_Hakugin_Post (0x6000)
};

function toS16(v) {
    return (v << 16) >> 16;
}

// z64math.h: DEG_TO_BINANG(deg) = TRUNCF_BINANG(deg * (0x8000 / 180.0f))
//            TRUNCF_BINANG(f)   = (s16)(s32)(f)
// The multiply is single precision on hardware, and the truncation to s32
// happens before the wrap to s16 -- both matter, since a 9-bit degree field
// can hold up to 511 degrees and therefore wraps past 0x7FFF.
const DEG_TO_BINANG_SCALE = f32(0x8000 / 180.0);
function degToBinang(deg) {
    return toS16(Math.trunc(f32(deg * DEG_TO_BINANG_SCALE)));
}

// One rotation word -> { binang, deg, flags }, mirroring Actor_SpawnEntry.
function decodeSpawnRot(word, isRaw) {
    const deg = (word >> 7) & 0x1FF;

    if (!isRaw) {
        return degToBinang(deg);
    }

    // Field is actor params, not an angle. The game still stores it in
    // home.rot, just without the degree conversion.
    return deg > 180 ? deg - 360 : deg;
}

/**
 * Decode one entry of a scene/room actor spawn list.
 *
 * @returns {{actorId:number, rot:number[], rotRaw:number[], params:number,
 *            csId:(number|null), halfDaysBits:(number|null), idFlags:number}}
 *          rot is binang and ready for the SkinMatrix helpers; rotRaw is the
 *          untouched packed words as they sit in the scene file.
 */
function decodeActorSpawnEntry(entry, game) {
    const rawId = entry.actorId & 0xFFFF;
    const rotRaw = [
        entry.rotation[0] & 0xFFFF,
        entry.rotation[1] & 0xFFFF,
        entry.rotation[2] & 0xFFFF
    ];
    const params = entry.actorParams & 0xFFFF;

    if (game !== "MM") {
        // OOT: nothing is packed. Only Actor_SpawnTransitionActors masks the
        // id with 0x1FFF, and regular spawn entries carry no flags at all
        // (verified: no entry in OOT_actors_by_scene.json sets bits 15-13).
        return {
            actorId: rawId,
            rot: [toS16(rotRaw[0]), toS16(rotRaw[1]), toS16(rotRaw[2])],
            rotRaw,
            params,
            csId: null,
            halfDaysBits: null,
            idFlags: 0
        };
    }

    const actorId = rawId & ACTOR_ENTRY_ID_MASK;
    const idFlags = (rawId & 0xE000) || (MM_ACTOR_ENTRY_ID_FLAGS[actorId] ?? 0);

    // halfDaysBits: 0 is spawn-on-every-half-day (HALFDAYBIT_ALL == 0x3FF),
    // matching Actor_SpawnAsChildAndCutscene / Actor_SpawnSetupActors.
    let halfDaysBits = ((rotRaw[0] & 0x7) << 7) | (rotRaw[2] & 0x7F);
    if (halfDaysBits === 0) {
        halfDaysBits = 0x3FF;
    }

    // csId 0x7F is CS_ID_NONE.
    const csIdRaw = rotRaw[1] & 0x7F;

    return {
        actorId,
        rot: [
            decodeSpawnRot(rotRaw[0], idFlags & ACTOR_ENTRY_ROTX_IS_RAW),
            decodeSpawnRot(rotRaw[1], idFlags & ACTOR_ENTRY_ROTY_IS_RAW),
            decodeSpawnRot(rotRaw[2], idFlags & ACTOR_ENTRY_ROTZ_IS_RAW)
        ],
        rotRaw,
        params,
        csId: csIdRaw === 0x7F ? null : csIdRaw,
        halfDaysBits,
        idFlags
    };
}

// ------------------------------------------------------------------
// Actor Init overrides for dynapoly rotation
// ------------------------------------------------------------------
// DynaPoly does NOT use the spawn rotation. z_bgcheck.c stores
// `actor->shape.rot` into the bg actor transform:
//
//     bgActor->curTransform.rot = actor->shape.rot;                (line ~2586)
//     ScaleRotPos_SetValue(&dyna->bgActors[bgId].curTransform,
//                          &actor->scale, &actor->shape.rot, &pos); (line ~2879)
//
// Actor_Init() seeds shape.rot from home.rot (Actor_SetWorldToHome then
// Actor_SetShapeRotToWorld) and THEN calls the actor's own Init, which is
// free to overwrite it. 31 of MM's ~118 dynapoly actors do exactly that.
// For those, using the spawn rotation renders collision at an angle the
// game never uses.
//
// Only the unconditional rewrites are encoded here -- entries whose Init
// only touches shape.rot inside an `if` (Bg_Icicle, Bg_Dblue_Movebg,
// Bg_Hakugin_Post, Bg_Ingate, Boss_05, Dm_Char01, Dm_Char08, Obj_Bean,
// Obj_Boat, Obj_Hunsui, Obj_Switch, Obj_Iceblock's 90-degree yaw snap) are
// deliberately left out rather than guessed at. Actors that only rewrite
// world.rot/home.rot (Bg_Crace_Movebg, Bg_Lotus, Obj_Yasi) need no entry:
// dyna never reads those.
//
// Each function takes the decoded spawn values and returns the shape.rot
// that DynaPoly_ExpandSRT would actually be handed.
const MM_ACTOR_INIT_SHAPE_ROT = {
    // z_en_box.c EnBox_Init:
    //     if (world.rot.x == 180) { world.rot.x = 0x7FFF; }   // upside-down chest
    //     else { collectableFlag = world.rot.x & 0x7F; world.rot.x = 0; }
    //     thisx->shape.rot.x = world.rot.x;
    //     ...
    //     shape.rot.y += 0x8000;
    //     home.rot.z = world.rot.z = shape.rot.z = 0;
    //
    // rot.x is a raw param field (the id carries 0x4000), so the literal
    // 180 really is the value in the spawn entry -- an upright chest stores
    // its collectable flag there instead, which is why an unconverted rot.x
    // shows up as a small bogus tilt.
    "En_Box": (rot) => [rot[0] === 180 ? 0x7FFF : 0, toS16(rot[1] + 0x8000), 0],

    // z_bg_hakugin_post.c BgHakuginPost_Init: only the instance with
    // (params & 7) == 7 loads collision at all -- every other one calls
    // Actor_Kill after registering itself. That instance zeroes pitch and
    // roll, and its rot.x/rot.z are switch flags (BGHAKUGINPOST_GET_SWITCH_FLAG_2
    // is `home.rot.x & 0x7F`), never angles.
    "Bg_Hakugin_Post": (rot, rotRaw, params) =>
        ((params & 7) === 7) ? [0, rot[1], 0] : rot,

    "Obj_Armos":       (rot) => [0, rot[1], 0],
    "Obj_Chikuwa":     (rot) => [rot[0], toS16(rot[1] + 0x2000), rot[2]], // home.rot.y += 0x2000, shape follows
    "Obj_Danpeilift":  (rot) => [0, rot[1], 0],
    "Obj_Driftice":    (rot) => [0, rot[1], 0],
    "Obj_Iceblock":    (rot) => [0, rot[1], 0], // yaw snap to 90 deg is conditional, not applied
    "Obj_Kibako2":     (rot) => [0, rot[1], 0],
    "Obj_Lift":        (rot) => [rot[0], rot[1], 0],
    "Obj_Lupygamelift":(rot) => [0, rot[1], 0],
    "Obj_Nozoki":      (rot) => [0, rot[1], 0],
    "Obj_Ocarinalift": (rot) => [0, rot[1], 0],
    "Obj_Pzlblock":    (rot) => [0, rot[1], 0],
    "Obj_Raillift":    (rot) => [0, rot[1], 0],
    "Obj_Spinyroll":   () => [0, 0, 0],
    "Obj_Vspinyroll":  () => [0, 0, 0],
};

/**
 * Spawn rotation -> the shape.rot DynaPoly actually uses, applying the
 * actor's Init override when it has one.
 */
function actorShapeRot(actorName, spawn, game) {
    if (game !== "MM") {
        return spawn.rot;
    }

    const override = MM_ACTOR_INIT_SHAPE_ROT[actorName];
    return override ? override(spawn.rot, spawn.rotRaw, spawn.params) : spawn.rot;
}

export async function renderZeldaObjectsInScene(scene, game, sceneName) {
    // Start every dynapoly row at its intended default for this map: actor
    // collision shown, standable-surface and seams overlays hidden.
    //
    // Saved visibility is keyed by model name and survives a scene load (which
    // is what lets a colour you picked persist). Carrying visibility across
    // scenes is wrong though -- unchecking an actor in one map left the same
    // actor unchecked on entering the next map, looking like collision had
    // failed to load. Colours are still remembered.
    resetGroupModelState('dynapoly');

    function normalizeTriangleIndices(tris, vertexCount) {
        if (!tris || tris.length === 0) {
            return tris;
        }

        const allIdx = [].concat(...tris);

        const maxIdx = Math.max(...allIdx);
        const minIdx = Math.min(...allIdx);

        if (
            minIdx >= 1 &&
            maxIdx <= vertexCount
        ) {
            return tris.map(tri =>
                tri.map(x => x - 1)
            );
        }

        return tris;
    }

    const objectCache = new Map();

    const setupDropdown = document.getElementById("setupDropdown");
    let setupID = 0;
    if(setupDropdown.value)
        setupID = setupDropdown.value;

    let json_path = null;

    // ------------------------------------------------------------
    // Load actors JSON
    // ------------------------------------------------------------
    json_path = './models/' + game + '/actors/' + game + '_actors.json';
    const actors = await fetchJSON(json_path);
    if (!actors) {
        console.log("Failed to parse 'actors' json in game: " + game);
        return;
    }
    //console.log(actors);

    // ------------------------------------------------------------
    // Load objects JSON
    // ------------------------------------------------------------
    json_path = './models/' + game + '/actors/' + game + '_objects.json';
    const objects = await fetchJSON(json_path);
    if (!objects) {
        console.log("Failed to parse 'objects' json in game: " + game);
        return;
    }
    //console.log(objects);

    // ------------------------------------------------------------
    // Process every room
    // ------------------------------------------------------------
    for (let i = 0; i < areaActors[setupID]["rooms"].length; i++) {
        const room = areaActors[setupID]["rooms"][i];

        // --------------------------------------------------------
        // Process every actor in room
        // --------------------------------------------------------
        for (let j = 0; j < room["actors"].length; j++) {
            const actor = room["actors"][j];

            // The spawn list stores the id and rotations bit-packed in MM;
            // decodeActorSpawnEntry() undoes that (and is a pass-through for
            // OOT). Everything below wants the decoded values -- rotXYZ in
            // particular is binang, which is what the SkinMatrix code and the
            // THREE rotation below both expect.
            const spawn = decodeActorSpawnEntry(actor, game);
            const actorId = spawn.actorId;
            const actorParams = spawn.params;
            const posXYZ = actor.position;
            const rotSpawnXYZ = spawn.rot;
            const rotRawXYZ = spawn.rotRaw;

            // ----------------------------------------------------
            // Get actor/object information
            // ----------------------------------------------------
            const actorTableEntry = actors[actorId];
            if (!actorTableEntry) {
                console.warn("Unknown actor id in spawn list:",
                    `0x${actorId.toString(16).toUpperCase()}`,
                    "(raw id word 0x" + (actor.actorId & 0xFFFF).toString(16).toUpperCase() + ")");
                continue;
            }
            const actorName = actorTableEntry["name"];
            //const actorObjectId = actorTableEntry["objectId"];
            //const objectName = objects[actorObjectId]["name"];

            // What DynaPoly actually rotates the collision by: shape.rot after
            // the actor's Init has had its say, not the raw spawn rotation.
            const rotXYZ = actorShapeRot(actorName, spawn, game);

            // ----------------------------------------------------
            // Check if this is a dynapoly actor
            // ----------------------------------------------------
            function getMaskShift(mask) {
                let shift = 0;

                while ((mask & 1) === 0) {
                    mask >>= 1;
                    shift++;
                }

                return shift;
            }
            
            let DynaPoly_Actors = null;
            let Dynapoly_Collisions = null;
            if (game == "OOT") {
                DynaPoly_Actors = OOT_Dynapoly_Actors;
                Dynapoly_Collisions = OOT_Dynapoly_Collisions;
            }
            else if (game == "MM") {
                DynaPoly_Actors = MM_Dynapoly_Actors;
                Dynapoly_Collisions = MM_Dynapoly_Collisions;
            }

            const dynaPolyActor = DynaPoly_Actors.find(i => {
                if (i.actor_name !== actorName)
                    return false;

                if (i.params_mask == null)
                    return true;

                const maskedParams = actorParams & i.params_mask;

                let paramValue;

                if (i.params_mask === 0xFFFF) {
                    // Special case: full 16-bit params.
                    // Do NOT shift, because values like 0xFFFF
                    // represent the entire params field.
                    paramValue = maskedParams;
                }
                else {
                    // Extract the masked field and shift it down
                    // so params_values contains the natural value.
                    const shift = getMaskShift(i.params_mask);
                    paramValue = maskedParams >> shift;
                }

                return i.params_values?.includes(paramValue);
            });

            if (!dynaPolyActor) {
                continue;
            }

            // `scale` in the dynapoly tables is one uniform multiplier, a
            // per-axis [x, y, z] triple, or a function of params, e.g.
            //   Bg_Hakugin_Switch    scale: 0.1
            //   Bg_Haka_Bombwall     scale: [0.07, 0.016, 0.07]
            //   En_Horse_Game_Check  scale: (params) => (((params >> 8) & 0xFF) * 0.001)
            //
            // The function form is needed for actors that compute their own
            // scale in Init instead of using a constant -- listing one table
            // row per observed params value instead silently drops any
            // instance whose value isn't in the list.
            //
            // The game stores actor->scale as a Vec3f and DynaPoly_ExpandSRT
            // passes each component separately into
            // SkinMatrix_SetTranslateRotateYXZScale, so a non-uniform scale
            // really does produce differently proportioned collision -- it
            // can't be collapsed to a single number.
            const scale = (typeof dynaPolyActor.scale === 'function')
                ? dynaPolyActor.scale(actorParams)
                : dynaPolyActor.scale;

            let scaleVec;
            if (Array.isArray(scale)) {
                scaleVec = { x: scale[0], y: scale[1], z: scale[2] };
            } else if (typeof scale === 'number') {
                scaleVec = { x: scale, y: scale, z: scale };
            } else {
                console.warn(
                    "Dynapoly actor has no usable scale, defaulting to 1:",
                    dynaPolyActor.actor_name, scale);
                scaleVec = { x: 1, y: 1, z: 1 };
            }

            // ----------------------------------------------------
            // Find collision information
            // ----------------------------------------------------
            const actorCollision = Dynapoly_Collisions.find(
                i => i.collision_name === dynaPolyActor.collision_name);
            if (!actorCollision) {
                alert('No collision found for dynapoly actor: ' + dynaPolyActor.actor_name);
                continue;
            }
            const objectName = actorCollision["file_name"];
            const cacheKey = `${objectName}:${actorCollision.offset}`;
            //console.log(actorName + ": " + objectName);
            //console.log(dynaPolyActor);
            //console.log(actorCollision);

            // ----------------------------------------------------
            // Load object binary
            // ----------------------------------------------------
            try {
                let cachedObject = objectCache.get(cacheKey);

                if (!cachedObject) {
                    const res = await fetch(
                        './models/' +
                        game +
                        '/actors/objects/' +
                        objectName
                    );

                    const buffer = await res.arrayBuffer();

                    const verts = [];
                    const tris = [];
                    const triangleData = [];

                    const intangibleTris = [];
                    const intangibleTriangleData = [];

                    const waterBoxes = [];

                    parseZeldaObjectBinary(
                        scene,
                        buffer,
                        false,
                        actorName,
                        objectName,
                        actorCollision.offset,
                        verts,
                        tris,
                        triangleData,
                        intangibleTris,
                        intangibleTriangleData,
                        waterBoxes
                    );

                    // Normalize indices ONCE before caching
                    const normalizedTris =
                        normalizeTriangleIndices(tris, verts.length);

                    const normalizedIntangibleTris =
                        normalizeTriangleIndices(
                            intangibleTris,
                            verts.length
                        );

                    cachedObject = {
                        verts,
                        tris: normalizedTris,
                        triangleData,

                        intangibleTris: normalizedIntangibleTris,
                        intangibleTriangleData,

                        waterBoxes
                    };

                    objectCache.set(cacheKey, cachedObject);
                    //console.log(objectName + ": Binary file length:", buffer.byteLength);
                }
                
                const actorTris = cachedObject.tris;

                const actorIntangibleTris =
                    cachedObject.intangibleTris;

                const actorWaterBoxes =
                    cachedObject.waterBoxes;

                // Note: triangle indices were already normalised to 0-based
                // by normalizeTriangleIndices() before caching. They used to
                // be re-normalised here per instance, which mutated the
                // shared cached arrays and could decrement them a second
                // time for any object that happens not to reference vertex 0.

                // ------------------------------------------------
                // Transform collision into world space
                // ------------------------------------------------
                // The game does not keep dynapoly collision in object space
                // and transform it while rendering. Once per frame
                // DynaPoly_ExpandSRT bakes each actor's vertices into world
                // space and stores them as Vec3s -- 16-bit INTEGERS -- then
                // recomputes every polygon normal and plane distance from
                // those truncated integers.
                //
                // So we bake here too, rather than putting the transform on
                // the THREE group. Doing it the "clean" way with a float
                // group transform gives subtly different geometry: vertices
                // land on non-integer coordinates, and normals stay at their
                // untransformed header values instead of being rederived.
                //
                // See dyna_transform.js for the details.

                const xform = {
                    scale: scaleVec,
                    rot: { x: rotXYZ[0], y: rotXYZ[1], z: rotXYZ[2] },
                    // shape.yOffset is 0 for most dynapoly actors; override
                    // per-actor in the dynapoly table if one needs it.
                    pos: dynaActorPos(posXYZ, scaleVec.y, dynaPolyActor.yOffset ?? 0)
                };

                const mkVec = (x, y, z) => new THREE.Vector3(x, y, z);

                // Integer world-space vertices, shared by tangible and
                // intangible polys (they index the same vertex list).
                const actorVerts = dynaTransformVertices(
                    cachedObject.verts, xform);

                // Normals/dist rederived from the truncated integer verts.
                // Builds new objects, so the shared cache is left untouched.
                const actorTriangleData = dynaRecomputePolyData(
                    actorVerts, actorTris, cachedObject.triangleData, mkVec);

                const actorIntangibleTriangleData = dynaRecomputePolyData(
                    actorVerts, actorIntangibleTris,
                    cachedObject.intangibleTriangleData, mkVec);

                // ------------------------------------------------
                // Validate triangle indices
                // ------------------------------------------------
                for (let k = 0; k < actorTris.length; k++) {
                    const [a, b, c] = actorTris[k];
                    if (a < 0 || b < 0 || c < 0 || a >= actorVerts.length || b >= actorVerts.length 
                        || c >= actorVerts.length) {
                        console.warn("Invalid triangle index", k, a, b, c, "verts:", actorVerts.length);
                    }
                }

                // ------------------------------------------------
                // Nothing to render
                // ------------------------------------------------
                if (
                    actorTris.length === 0 &&
                    actorIntangibleTris.length === 0 &&
                    actorWaterBoxes.length === 0
                ) {
                    continue;
                }

                // ------------------------------------------------
                // Build actor group
                // ------------------------------------------------
                const modelName = actorName + ": " + dynaPolyActor.actor_description;

                const actorGroup = new THREE.Object3D();
                actorGroup.name = modelName;

                // The collision meshes below are already in world space (see
                // the transform block above), so the group itself stays at
                // identity. Anything that needs world coordinates can keep
                // using localToWorld() and will simply get a no-op.


                // ------------------------------------------------
                // Store actor information on group
                // ------------------------------------------------
                actorGroup.userData.actorName = actorName;
                actorGroup.userData.actorId = actorId;
                actorGroup.userData.objectName = objectName;
                actorGroup.userData.params = actorParams;
                actorGroup.userData.position = posXYZ;
                actorGroup.userData.rotation = rotXYZ;          // shape.rot used by dyna
                actorGroup.userData.rotationSpawn = rotSpawnXYZ; // before Init overrides
                actorGroup.userData.rotationRaw = rotRawXYZ;     // packed scene words
                actorGroup.userData.csId = spawn.csId;
                actorGroup.userData.halfDaysBits = spawn.halfDaysBits;
                actorGroup.userData.scale = scale;
                actorGroup.userData.scaleVec = scaleVec;
                actorGroup.userData.collisionName = dynaPolyActor.collision_name;

                // Each collision category keeps its own colour, matching the
                // scene-level models: tangible orange, intangible green,
                // waterboxes cyan (set inside buildWaterBoxModel). Passing
                // the same colour for tangible and intangible is what made a
                // mixed actor look like it was entirely one or the other.
                const DYNA_TANGIBLE_COLOR = 0xff7b24;
                const DYNA_INTANGIBLE_COLOR = 0x3aff78;

                // All wireframe edges live under one subgroup so the global
                // "Draw triangle/cube edges" checkbox can toggle them. That
                // handler needs a single `edges` object per loadedModels
                // entry, and a dynapoly actor has one edges object per part.
                const edgesGroup = new THREE.Object3D();
                edgesGroup.name = modelName + " Edges";
                edgesGroup.visible = wireframeCheckbox.checked;
                actorGroup.add(edgesGroup);

                // The swatch on the actor's row drives whichever part the
                // row's colour represents -- normally the tangible mesh.
                // The other parts keep their fixed semantic colours.
                let tangibleMesh = null;
                let intangibleMesh = null;
                let waterboxMesh = null;

                // ------------------------------------------------
                // Tangible collision
                // ------------------------------------------------
                if (actorTris.length > 0) {
                    const result = buildGeometryButDontAddToScene(
                        scene,
                        actorVerts,
                        actorTris,
                        actorTriangleData,
                        null,
                        modelName,
                        false,
                        false,
                        DYNA_TANGIBLE_COLOR
                    );

                    if (result) {
                        // Make sure selection can identify this as a dynapoly
                        result.mesh.userData.triangles = actorTriangleData;
                        result.mesh.userData.dynaPolyActor = actorGroup;
                        result.mesh.userData.collisionType = "tangible";

                        result.edges.userData.dynaPolyActor = actorGroup;

                        tangibleMesh = result.mesh;

                        // edgesGroup owns edge visibility now, so the child
                        // stays unconditionally visible. Leaving the builder's
                        // own wireframe-dependent flag on it would keep the
                        // edges hidden even after the group was switched on.
                        result.edges.visible = true;

                        actorGroup.add(result.mesh);
                        edgesGroup.add(result.edges);
                    }
                }


                // ------------------------------------------------
                // Intangible collision
                // ------------------------------------------------
                if (actorIntangibleTris.length > 0) {
                    const result = buildGeometryButDontAddToScene(
                        scene,
                        actorVerts,
                        actorIntangibleTris,
                        actorIntangibleTriangleData,
                        null,
                        modelName + " Intangible",
                        false,
                        true,
                        DYNA_INTANGIBLE_COLOR
                    );

                    if (result) {
                        // Make sure selection can identify this as a dynapoly
                        result.mesh.userData.triangles = actorIntangibleTriangleData;
                        result.mesh.userData.dynaPolyActor = actorGroup;
                        result.mesh.userData.collisionType = "intangible";

                        result.edges.userData.dynaPolyActor = actorGroup;

                        intangibleMesh = result.mesh;

                        result.edges.visible = true;

                        actorGroup.add(result.mesh);
                        edgesGroup.add(result.edges);
                    }
                }


                // ------------------------------------------------
                // Waterboxes
                // ------------------------------------------------
                if (actorWaterBoxes.length > 0) {
                    const {
                        mesh: waterMesh,
                        edges: waterEdges
                    } = buildWaterBoxModel(
                        actorWaterBoxes,
                        waterboxCheckbox.checked
                    );

                    waterMesh.userData.dynaPolyActor = actorGroup;
                    waterMesh.userData.collisionType = "waterbox";

                    waterEdges.userData.dynaPolyActor = actorGroup;

                    waterboxMesh = waterMesh;

                    // DynaPoly_ExpandSRT only bakes vertices and polygons --
                    // it does not touch waterboxes, so there is no integer
                    // truncation to reproduce for them. They stay in object
                    // space under their own transformed subgroup.
                    const waterGroup = new THREE.Object3D();
                    waterGroup.name = modelName + " Waterboxes";

                    waterGroup.position.set(
                        xform.pos.x,
                        xform.pos.y,
                        xform.pos.z
                    );

                    // YXZ, matching SkinMatrix_SetRotateYXZ. The default
                    // THREE order is XYZ, which differs for any actor
                    // rotated about more than one axis.
                    waterGroup.rotation.order = 'YXZ';
                    waterGroup.rotation.set(
                        (rotXYZ[0] / 0x8000) * Math.PI,
                        (rotXYZ[1] / 0x8000) * Math.PI,
                        (rotXYZ[2] / 0x8000) * Math.PI
                    );

                    waterGroup.scale.set(scaleVec.x, scaleVec.y, scaleVec.z);

                    waterGroup.add(waterMesh);
                    waterGroup.add(waterEdges);
                    actorGroup.add(waterGroup);
                }


                // ------------------------------------------------
                // Add entire actor to scene
                // ------------------------------------------------
                scene.add(actorGroup);


                // ------------------------------------------------
                // Register entire actor as one loaded model
                // ------------------------------------------------
                // Registering edgesGroup here is what lets the global
                // "Draw triangle/cube edges" checkbox reach a dynapoly actor;
                // with edges: null it skipped them entirely.
                loadedModels.push({
                    name: modelName,
                    root: actorGroup,
                    mesh: actorGroup,
                    edges: edgesGroup
                });

                // Row colour follows whichever part the swatch will drive, so
                // the swatch never advertises a colour belonging to a part it
                // doesn't control. edgesObj stays null: hiding the actor hides
                // edgesGroup along with it, and the wireframe checkbox owns
                // edge visibility on its own.
                const rowColorTarget = tangibleMesh ?? intangibleMesh ?? waterboxMesh;
                const rowColor = tangibleMesh ? '#ff7b24'
                    : (intangibleMesh ? '#3aff78' : '#00ffff');

                // Dynapoly rows live in their own scrollable box with a
                // master show/hide, since a busy scene can have dozens of
                // them and they would otherwise bury every other control.
                // Created lazily, so scenes with no dynapoly get no box.
                const dynaGroup = getModelGroup('dynapoly', 'DynaPoly Actors');

                addModelCheckbox(
                    scene,
                    modelName,
                    actorGroup,
                    null,
                    false,
                    true,
                    rowColor,
                    false,
                    rowColorTarget,
                    dynaGroup.body
                );

                // ------------------------------------------------
                // Standable-surface overlays for this actor
                // ------------------------------------------------
                // Same treatment the scene collision gets, but with the
                // dynapoly determinant tolerance so the region reaches as far
                // past each poly's edges as the game actually allows.
                //
                // colCtx is null: dynapoly polys are never registered in the
                // static subdivision system, so there is no per-subdivision
                // filtering to apply (this matches what selection.js passes for
                // dynapoly sample points).
                //
                // Both default to hidden. A busy scene has dozens of dynapoly
                // actors, and turning every overlay on at load would bury the
                // scene in overlapping red.
                if (actorTriangleData.length > 0) {
                    const dynaStandable = renderStandableSurfaceXZ(
                        actorTriangleData,
                        null,
                        groundClipBandsCheckbox?.checked ?? true,
                        STANDABLE_DET_MAX_DYNAPOLY
                    );

                    if (dynaStandable) {
                        const {
                            main: dynaStandableMain,
                            vertexBulge: dynaStandableBulge
                        } = dynaStandable;

                        if (dynaStandableMain) {
                            const nm = actorName + " Standable Surface";
                            scene.add(dynaStandableMain);

                            if (dynaStandableMain.children[1]) {
                                dynaStandableMain.children[1].visible =
                                    wireframeCheckbox.checked;
                            }

                            dynaStandableMain.userData.dynaPolyActor = actorGroup;

                            loadedModels.push({
                                name: nm,
                                mesh: dynaStandableMain,
                                edges: dynaStandableMain.children[1]
                            });

                            addModelCheckbox(
                                scene, nm, dynaStandableMain, null, false, true,
                                '#ff0000', false,
                                primaryColorTarget(dynaStandableMain),
                                dynaGroup.body
                            );
                        }

                        if (dynaStandableBulge) {
                            const nm = actorName + " Seams";
                            scene.add(dynaStandableBulge);

                            if (dynaStandableBulge.children[1]) {
                                dynaStandableBulge.children[1].visible =
                                    wireframeCheckbox.checked;
                            }

                            dynaStandableBulge.userData.dynaPolyActor = actorGroup;

                            loadedModels.push({
                                name: nm,
                                mesh: dynaStandableBulge,
                                edges: dynaStandableBulge.children[1]
                            });

                            addModelCheckbox(
                                scene, nm, dynaStandableBulge, null, false, true,
                                '#00cc44', false,
                                primaryColorTarget(dynaStandableBulge),
                                dynaGroup.body
                            );
                        }
                    }
                }

                // ------------------------------------------------
                // Save useful actor information
                // ------------------------------------------------
                actorGroup.userData.actorName = actorName;
                actorGroup.userData.actorId = actorId;
                actorGroup.userData.objectName = objectName;
                //actorGroup.userData.objectId = actorObjectId;
                actorGroup.userData.params = actorParams;
                actorGroup.userData.position = posXYZ;
                actorGroup.userData.rotation = rotXYZ;          // shape.rot used by dyna
                actorGroup.userData.rotationSpawn = rotSpawnXYZ; // before Init overrides
                actorGroup.userData.rotationRaw = rotRawXYZ;     // packed scene words
                actorGroup.userData.csId = spawn.csId;
                actorGroup.userData.halfDaysBits = spawn.halfDaysBits;
                actorGroup.userData.scale = scale;
                actorGroup.userData.scaleVec = scaleVec;
                actorGroup.userData.collisionName = dynaPolyActor.collision_name;
                console.log("Rendered dynapoly:", actorName, "position:", posXYZ,
                    "shape.rot (binang):", rotXYZ, "spawn rot (binang):", rotSpawnXYZ,
                    "rot (raw words):", rotRawXYZ,
                    "scale:", scale, "params:", `0x${actorParams.toString(16).toUpperCase()}`);
                
            } catch (err) {
                console.error("Failed to load dynapoly object:", objectName, err);
            }
        }
    }
}
