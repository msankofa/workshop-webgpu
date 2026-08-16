// scratch probe: print the auto-mapped rig for one or more extracted Stadium models
import fs from 'node:fs';
import { mapStadiumRigFromGLB } from './stadium-rig-map.js';

for (const f of process.argv.slice(2)) {
  const { map } = mapStadiumRigFromGLB(fs.readFileSync(`models/stadium/${f}.glb`), { source: f });
  const n = (i) => map.names[i] || i;
  console.log('===', f, 'h=' + map.units.height.toFixed(1), 'ride=' + map.rideHeight.toFixed(1),
    'fwd=' + map.forward.axis + map.forward.sign, 'body=' + n(map.body));
  console.log('  head', map.head ? map.head.bones.map(n).join('>') + ` (${map.head.count}v)` : '-',
    '| tail', map.tail ? map.tail.bones.map(n).join('>') : '-', '| spine', map.spine.map(n).join('>'));
  for (const L of map.legs) console.log('  row' + L.row, L.side < 0 ? 'L' : 'R', L.bones.map(n).join('>').padEnd(28),
    'hip=(' + [L.hip.x, L.hip.y, L.hip.z].map(v => v.toFixed(1)).join(',') + ')',
    'knee=(' + [L.knee.x, L.knee.y, L.knee.z].map(v => v.toFixed(1)).join(',') + ')',
    'foot=(' + [L.foot.x, L.foot.y, L.foot.z].map(v => v.toFixed(1)).join(',') + ')',
    'l1=' + L.l1.toFixed(1), 'l2=' + L.l2.toFixed(1), 'k=' + L.kneeIndex);
  for (const w of map.warnings) console.log('  WARN', w);
}
