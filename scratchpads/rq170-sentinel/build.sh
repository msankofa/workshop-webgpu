#!/bin/sh
# Rebuild the RQ-170 from the skeleton: spec -> material evidence -> gates -> factory -> bundle -> measure.
set -e
S=~/.claude/skills/img2threejs
export PYTHONIOENCODING=utf-8
python3 author_spec.py
python3 $S/forge/stage1_intake/extract_pbr_evidence.py matcrops/airframe.png --out-dir pbr/airframe --material-id airframe --url-prefix pbr/airframe --spec object-sculpt-spec.json --in-place --target-threshold 0.6 > /dev/null
python3 $S/forge/stage1_intake/extract_pbr_evidence.py matcrops/dark-polymer.png --out-dir pbr/dark-polymer --material-id dark-polymer --url-prefix pbr/dark-polymer --spec object-sculpt-spec.json --in-place > /dev/null
python3 $S/forge/stage1_intake/extract_pbr_evidence.py matcrops/gear-metal.png --out-dir pbr/gear-metal --material-id gear-metal --url-prefix pbr/gear-metal --spec object-sculpt-spec.json --in-place > /dev/null
python3 flatten_maps.py
python3 $S/forge/stage2_spec/validate_sculpt_spec.py object-sculpt-spec.json --strict-quality | grep -v "^warning" | tail -20
mkdir -p src
python3 $S/forge/stage3_build/generate_threejs_factory.py object-sculpt-spec.json --out src/createRq170Model.ts --force | tail -3
~/.claude/tools/node_modules/.bin/esbuild src/createRq170Model.ts --alias:three=C:/Users/msankofa/.claude/tools/node_modules/three --bundle --format=esm --outfile=factory.mjs --log-level=warning
~/.claude/tools/node_modules/.bin/esbuild viewer-entry.js --alias:three=C:/Users/msankofa/.claude/tools/node_modules/three --bundle --format=esm --outfile=viewer.js --log-level=warning
node smoke.mjs | tail -2
node silhouette.mjs > /dev/null
python3 compare_views.py | head -8
