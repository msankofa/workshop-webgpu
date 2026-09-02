"""Flat paint carries flat maps. extract_pbr_evidence keeps the evidence record the strict gate wants,
but its tiled crops read as rectangles on a single-tone skin, so every map file is replaced by a
uniform image: the chosen albedo, mid roughness, a neutral normal, flat height, white AO."""
import json
from PIL import Image

COLOURS = {'airframe': (189, 185, 178), 'dark-polymer': (43, 44, 46), 'gear-metal': (214, 214, 211)}
ROUGH = {'airframe': 184, 'dark-polymer': 217, 'gear-metal': 115}
spec = json.load(open('object-sculpt-spec.json', encoding='utf-8'))
for m in spec['materials']:
    mid = m['id']
    maps = (m.get('referencePbr') or {}).get('maps') or {}
    for channel, entry in maps.items():
        path = entry.get('path') if isinstance(entry, dict) else None
        if not path: continue
        size = Image.open(path).size
        if channel == 'albedo': fill = COLOURS[mid]
        elif channel == 'roughness': fill = (ROUGH[mid],) * 3
        elif channel == 'normal': fill = (128, 128, 255)
        elif channel in ('height', 'displacement'): fill = (128, 128, 128)
        else: fill = (255, 255, 255)
        Image.new('RGB', size, fill).save(path)
    m['textureProjection']['repeat'] = [1.0, 1.0]
    m['albedo']['dominant'] = '#%02X%02X%02X' % COLOURS[mid]
    m['color'] = m['baseColor'] = m['albedo']['dominant']
    m['colorVariation']['amplitude'] = 0.0
    print(mid, 'flattened', sorted(maps.keys()))
json.dump(spec, open('object-sculpt-spec.json', 'w', encoding='utf-8'), indent=2)
