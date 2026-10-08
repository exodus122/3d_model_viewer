////////////////////////////////////////
// System: Banjo-Tooie texture bank
////////////////////////////////////////
//
// Most BT models carry no texture pixels of their own: each texture list
// entry names a texture id, and the game DMAs asset 0x1EF6 + id into the
// model's segment-2 buffer in entry order (see bk_model.js, UCODES). The
// extractor (banjo-tooie tools/extract_maps.py) splits that asset range into
// models/BT/textures/:
//   index.bin    "BTTI", u32 count, u32 ids per chunk,
//                count * { u32 offset in its chunk, u32 size }
//   <NNN>.bin    chunk NNN (3 hex digits): the data of ids NNN * per chunk ..
// A map needs a few hundred KB of the ~9 MB bank, so only the chunks its
// models name are fetched (loadBTModelTextures), each once per session.
// Lookups (bank.get) stay synchronous for the model parser; an id whose chunk
// isn't loaded reads as missing and its surfaces draw untextured.

const BANK_DIR = './models/BT/textures/';
const INDEX_MAGIC = 0x42545449;   // "BTTI"
const MODEL_MAGIC = 0x0000000B;
const TEXTURE_ENTRY_SIZE = 8;     // BT texture list entry: { s32 id, u8 flags, type, width, height }

let bank = null;          // { count, get(id) -> Uint8Array | null }
let bankPromise = null;
const chunkData = new Map();      // chunk -> Uint8Array
const chunkPromises = new Map();  // chunk -> Promise

/** Fetch the bank's index (idempotent). Resolves to the bank, or null on failure. */
export function loadBTTextureBank() {
    if (!bankPromise) {
        bankPromise = fetch(BANK_DIR + 'index.bin')
            .then(res => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                return res.arrayBuffer();
            })
            .then(buffer => {
                const dv = new DataView(buffer);
                if (dv.getUint32(0, false) !== INDEX_MAGIC) throw new Error('bad texture bank index magic');
                const count = dv.getUint32(4, false);
                const perChunk = dv.getUint32(8, false);
                bank = {
                    count,
                    perChunk,
                    get(id) {
                        if (id < 0 || id >= count) return null;
                        const data = chunkData.get(Math.floor(id / perChunk));
                        if (!data) return null;
                        const off = dv.getUint32(12 + 8 * id, false);
                        const size = dv.getUint32(16 + 8 * id, false);
                        return size ? data.subarray(off, off + size) : null;
                    },
                };
                console.log(`BT texture bank: ${count} textures in chunks of ${perChunk}`);
                return bank;
            })
            .catch(err => {
                bankPromise = null;
                console.error('BT texture bank failed to load:', err);
                return null;
            });
    }
    return bankPromise;
}

/** The bank if its index has loaded, else null (models then draw untextured). */
export function getBTTextureBank() {
    return bank;
}

function loadChunk(chunk) {
    if (!chunkPromises.has(chunk)) {
        const name = chunk.toString(16).toUpperCase().padStart(3, '0') + '.bin';
        chunkPromises.set(chunk, fetch(BANK_DIR + name)
            .then(res => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                return res.arrayBuffer();
            })
            .then(buffer => { chunkData.set(chunk, new Uint8Array(buffer)); })
            .catch(err => {
                chunkPromises.delete(chunk);
                console.error(`BT texture chunk ${name} failed to load:`, err);
            }));
    }
    return chunkPromises.get(chunk);
}

/** The bank texture ids a BT model's texture list names (none if it embeds its pixels). */
export function btModelTextureIds(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x38 || dv.getUint32(0, false) !== MODEL_MAGIC) return [];
    const list = dv.getInt16(0x08, false);
    const gfx = dv.getInt32(0x0C, false);
    if (!list || list + 8 > dv.byteLength) return [];
    const count = dv.getInt16(list + 4, false);
    const dataBase = list + 8 + count * TEXTURE_ENTRY_SIZE;
    // Embedded pixels sit between the entries and the gfx list (bk_model.js)
    if (gfx > dataBase || dataBase > dv.byteLength) return [];
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(dv.getInt32(list + 8 + i * TEXTURE_ENTRY_SIZE, false));
    return ids;
}

/** Make the bank textures a BT model uses available to bank.get (fetches their chunks once). */
export async function loadBTModelTextures(buffer) {
    const loaded = await loadBTTextureBank();
    if (!loaded) return;
    const chunks = new Set();
    for (const id of btModelTextureIds(buffer)) {
        if (id >= 0 && id < loaded.count) chunks.add(Math.floor(id / loaded.perChunk));
    }
    await Promise.all([...chunks].map(loadChunk));
}
