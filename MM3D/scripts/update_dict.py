import os
import json
import re

# Original MM3D_Maps array as Python list of dicts
MM3D_Maps = [
	{ "name": "Ancient Castle of Ikana", "file": "z2_castle_info.zsi" },
	{ "name": "Astral Observatory", "file": "z2_tenmon_dai_info.zsi" },
	{ "name": "Before the Portal to Termina", "file": "z2_openingdan_info.zsi" },
	{ "name": "Beneath the Graves", "file": "z2_hakashita_info.zsi" },
	{ "name": "Beneath the Well", "file": "z2_redead_info.zsi" },
	{ "name": "Bomb Shop", "file": "z2_bomya_info.zsi" },
	{ "name": "Clock Tower Interior", "file": "z2_insidetower_info.zsi" },
	{ "name": "Clock Tower Rooftop", "file": "z2_okujou_info.zsi" },
	{ "name": "Cucco Shack", "file": "z2_f01c_info.zsi" },
	{ "name": "Curiosity Shop & Kafei's Hideout", "file": "z2_ayashiishop_info.zsi" },
	{ "name": "Cutscene Map", "file": "spot00_info.zsi" },
	{ "name": "Dampe's House", "file": "z2_danpei2test_info.zsi" },
	{ "name": "Deku King's Chamber", "file": "z2_deku_king_info.zsi" },
	{ "name": "Deku Palace", "file": "z2_22dekucity_info.zsi" },
	{ "name": "Deku Scrub Playground", "file": "z2_dekutes_info.zsi" },
	{ "name": "Deku Shrine", "file": "z2_danpei_info.zsi" },
	{ "name": "Doggy Racetrack", "file": "z2_f01_b_info.zsi" },
	{ "name": "East Clock Town", "file": "z2_town_info.zsi" },
	{ "name": "Fairy's Fountain", "file": "z2_yousei_izumi_info.zsi" },
	{ "name": "Fisherman's Hut", "file": "z2_fisherman_info.zsi" },
	{ "name": "Ghost Hut", "file": "z2_tougites_info.zsi" },
	{ "name": "Giants' Chamber", "file": "z2_kyojinnoma_info.zsi" },
	{ "name": "Goht's Lair", "file": "z2_hakugin_bs_info.zsi" },
	{ "name": "Gorman Track", "file": "z2_koeponarace_info.zsi" },
	{ "name": "Goron Graveyard", "file": "z2_goron_haka_info.zsi" },
	{ "name": "Goron Racetrack", "file": "z2_goronrace_info.zsi" },
	{ "name": "Goron Shop", "file": "z2_goronshop_info.zsi" },
	{ "name": "Goron Shrine", "file": "z2_16goron_house_info.zsi" },
	{ "name": "Goron Village (Spring)", "file": "z2_11goronnosato2_info.zsi" },
	{ "name": "Goron Village (Winter)", "file": "z2_11goronnosato_info.zsi" },
	{ "name": "Great Bay Temple", "file": "z2_sea_info.zsi" },
	{ "name": "Great Bay Coast", "file": "z2_30gyoson_info.zsi" },
	{ "name": "Great Bay Coast (Cutscene)", "file": "z2_konpeki_ent_info.zsi" },
	{ "name": "Grottos", "file": "kakusiana_info.zsi" },
	{ "name": "Gyorg's Lair", "file": "z2_sea_bs_info.zsi" },
	{ "name": "Honey & Darling's Shop", "file": "z2_bowling_info.zsi" },
	{ "name": "Igos du Ikana's Lair", "file": "z2_ikninside_info.zsi" },
	{ "name": "Ikana Canyon", "file": "z2_ikana_info.zsi" },
	{ "name": "Ikana Graveyard", "file": "z2_boti_info.zsi" },
	{ "name": "Laundry Pool", "file": "z2_alley_info.zsi" },
	{ "name": "Lost Woods", "file": "z2_lost_woods_info.zsi" },
	{ "name": "Lottery Shop", "file": "z2_takarakuji_info.zsi" },
	{ "name": "Magic Hags' Potion Shop", "file": "z2_witch_shop_info.zsi" },
	{ "name": "Majora's Lair", "file": "z2_last_bs_info.zsi" },
	{ "name": "Marine Research Lab", "file": "z2_labo_info.zsi" },
	{ "name": "Mayor's Residence", "file": "z2_sonchonoie_info.zsi" },
	{ "name": "Milk Bar", "file": "z2_milk_bar_info.zsi" },
	{ "name": "Milk Road", "file": "z2_romanymae_info.zsi" },
	{ "name": "Mountain Smithy", "file": "z2_kajiya_info.zsi" },
	{ "name": "Mountain Village (Spring)", "file": "z2_10yukiyamanomura2_info.zsi" },
	{ "name": "Mountain Village (Winter)", "file": "z2_10yukiyamanomura_info.zsi" },
	{ "name": "Music Box House", "file": "z2_musichouse_info.zsi" },
	{ "name": "North Clock Town", "file": "z2_backtown_info.zsi" },
	{ "name": "Ocean Fishing Hole", "file": "z2_turibori2_info.zsi" },
	{ "name": "Oceanside Spider House", "file": "z2_kindan2_info.zsi" },
	{ "name": "Odolwa's Lair", "file": "z2_miturin_bs_info.zsi" },
	{ "name": "Path to Goron Village (Spring)", "file": "z2_17setugen2_info.zsi" },
	{ "name": "Path to Goron Village (Winter)", "file": "z2_17setugen_info.zsi" },
	{ "name": "Path to Mountain Village", "file": "z2_13hubukinomiti_info.zsi" },
	{ "name": "Path to Snowhead", "file": "z2_14yukidamanomiti_info.zsi" },
	{ "name": "Pinnacle Rock", "file": "z2_sinkai_info.zsi" },
	{ "name": "Pirates' Fortress", "file": "z2_kaizoku_info.zsi" },
	{ "name": "Pirates' Fortress Exterior", "file": "z2_toride_info.zsi" },
	{ "name": "Pirates' Fortress Interior", "file": "z2_pirate_info.zsi" },
	{ "name": "Post Office", "file": "z2_posthouse_info.zsi" },
	{ "name": "Ranch House & Barn", "file": "z2_omoya_info.zsi" },
	{ "name": "Road to Ikana", "file": "z2_ikanamae_info.zsi" },
	{ "name": "Road to Southern Swamp", "file": "z2_24kemonomiti_info.zsi" },
	{ "name": "Romani Ranch", "file": "z2_f01_info.zsi" },
	{ "name": "Sakon's Hideout", "file": "z2_secom_info.zsi" },
	{ "name": "Secret Shrine", "file": "z2_random_info.zsi" },
	{ "name": "Snowhead", "file": "z2_12hakuginmae_info.zsi" },
	{ "name": "Snowhead Temple", "file": "z2_hakugin_info.zsi" },
	{ "name": "South Clock Town", "file": "z2_clocktower_info.zsi" },
	{ "name": "Southern Swamp (Clear)", "file": "z2_20sichitai2_info.zsi" },
	{ "name": "Southern Swamp (Poisoned)", "file": "z2_20sichitai_info.zsi" },
	{ "name": "Stock Pot Inn", "file": "z2_yadoya_info.zsi" },
	{ "name": "Stone Tower", "file": "z2_f40_info.zsi" },
	{ "name": "Stone Tower (Inverted)", "file": "z2_f41_info.zsi" },
	{ "name": "Stone Tower Temple", "file": "z2_inisie_n_info.zsi" },
	{ "name": "Stone Tower Temple (Inverted)", "file": "z2_inisie_r_info.zsi" },
	{ "name": "Swamp Fishing Hole", "file": "z2_turibori_info.zsi" },
	{ "name": "Swamp Shooting Gallery", "file": "z2_syateki_mori_info.zsi" },
	{ "name": "Swamp Spider House", "file": "z2_kinsta1_info.zsi" },
	{ "name": "Swordsman's School", "file": "z2_doujou_info.zsi" },
	{ "name": "Termina Field", "file": "z2_00keikoku_info.zsi" },
	{ "name": "Termina Field (Credits Cutscene)", "file": "z2_01keikoku_info.zsi" },
	{ "name": "Termina Field (Credits Cutscene)", "file": "z2_02keikoku_info.zsi" },
	{ "name": "Test Map 01", "file": "test01_info.zsi" },
	{ "name": "Test Map 02", "file": "test02_info.zsi" },
	{ "name": "The Moon", "file": "z2_sougen_info.zsi" },
	{ "name": "The Moon - Deku Trial", "file": "z2_last_deku_info.zsi" },
	{ "name": "The Moon - Goron Trial", "file": "z2_last_goron_info.zsi" },
	{ "name": "The Moon - Link Trial", "file": "z2_last_link_info.zsi" },
	{ "name": "The Moon - Zora Trial", "file": "z2_last_zora_info.zsi" },
	{ "name": "Tourist Information", "file": "z2_map_shop_info.zsi" },
	{ "name": "Town Shooting Gallery", "file": "z2_syateki_mizu_info.zsi" },
	{ "name": "Trading Post", "file": "z2_8itemshop_info.zsi" },
	{ "name": "Treasure Chest Shop", "file": "z2_takaraya_info.zsi" },
	{ "name": "Twinmold's Lair", "file": "z2_inisie_bs_info.zsi" },
	{ "name": "Waterfall Rapids", "file": "z2_35taki_info.zsi" },
	{ "name": "West Clock Town", "file": "z2_ichiba_info.zsi" },
	{ "name": "Woodfall", "file": "z2_21miturinmae_info.zsi" },
	{ "name": "Woodfall Temple", "file": "z2_miturin_info.zsi" },
	{ "name": "Woods of Mystery", "file": "z2_26sarunomori_info.zsi" },
	{ "name": "Zora Cape", "file": "z2_31misaki_info.zsi" },
	{ "name": "Zora Hall", "file": "z2_33zoracity_info.zsi" },
	{ "name": "Zora Hall Rooms", "file": "z2_bandroom_info.zsi" },
	{ "name": "32kamejimamae", "file": "z2_32kamejimamae_info.zsi" },
	{ "name": "meganeana", "file": "z2_meganeana_info.zsi" },
	{ "name": "zolashop", "file": "z2_zolashop_info.zsi" }
]

# Build a lookup from file prefix -> map object
prefix_to_map = {entry["file"].replace(".zsi", ""): entry for entry in MM3D_Maps}

# Scan current directory for *_seams.txt files
for fname in os.listdir("."):
    if fname.endswith("_seams.txt"):
        # extract prefix
        prefix = re.sub(r"_seams\.txt$", "", fname)
        if prefix in prefix_to_map:
            prefix_to_map[prefix]["seams"] = fname
        else:
            print(f"Warning: {fname} does not match any map in MM3D_Maps")

# Output updated JS array
js_array = "const MM3D_Maps = " + json.dumps(MM3D_Maps, indent=4) + ";"

with open("MM3D_Maps_updated.js", "w", encoding="utf-8") as f:
    f.write(js_array)

print("Done. Updated MM3D_Maps with seams files.")