////////////////////////////////////////
// System: Banjo-Tooie texture bank
////////////////////////////////////////
//
// Most BT models carry no texture pixels of their own: each texture list
// entry names a texture id, and the game DMAs asset 0x1EF6 + id into the
// model's segment-2 buffer in entry order (see bk_model.js, UCODES). The
// extractor packs that whole asset range into models/BT/textures.bin:
//   "BTTX", u32 count, count * { u32 offset, u32 size }, then the data.
// Loaded once per session, the first time a BT map is opened.

const BANK_URL = './models/BT/textures.bin';

let bank = null;          // { count, get(id) -> Uint8Array | null }
let bankPromise = null;

/** Fetch and index the bank (idempotent). */
export function loadBTTextureBank() {
    if (!bankPromise) {
        bankPromise = fetch(BANK_URL)
            .then(res => res.arrayBuffer())
            .then(buffer => {
                const dv = new DataView(buffer);
                if (dv.getUint32(0, false) !== 0x42545458) throw new Error('bad texture bank magic'); // "BTTX"
                const count = dv.getUint32(4, false);
                const bytes = new Uint8Array(buffer);
                bank = {
                    count,
                    get(id) {
                        if (id < 0 || id >= count) return null;
                        const off = dv.getUint32(8 + 8 * id, false);
                        const size = dv.getUint32(12 + 8 * id, false);
                        return size ? bytes.subarray(off, off + size) : null;
                    },
                };
                console.log(`BT texture bank: ${count} textures, ${buffer.byteLength} bytes`);
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

/** The bank if loadBTTextureBank() has finished, else null (models then draw untextured). */
export function getBTTextureBank() {
    return bank;
}
