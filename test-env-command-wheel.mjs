// The command wheel lives inline in environment-viewer-v2.html, which cannot run in Node (WebGPU +
// three), so this parses the source for the wiring that is easy to half-finish: a flag that is set by
// the UI but never fed to the FSM does nothing, and looks identical in the code to one that works.
// Same approach as test-bot-fire-aim-sync.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = 'environment-viewer-v2.html';
const src = fs.readFileSync(path.join(here, VIEWER), 'utf8');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

console.log('command wheel: input');
check('middle mouse opens the wheel', /e\.button === 1\).*openCommandWheel\(\)/s.test(src));
check('releasing middle commits it', /e\.button === 1\) \{ closeCommandWheel\(true\)/.test(src));
check('the spoke is picked from movementX/Y, not a frozen cursor',
  /updateCommandWheelByMovement[\s\S]{0,400}movementX/.test(src),
  'under pointer lock clientX/Y never changes, so a cursor-position pick would always hit the same spoke');
check('a mousemove while the wheel is open does not also turn the camera',
  /commandWheelOpen\) \{ updateCommandWheelByMovement\(e\); return; \}/.test(src));
check('losing pointer lock closes the wheel',
  /pointerlockchange[\s\S]{0,300}closeCommandWheel\(false\)/.test(src),
  'no matching mouseup is delivered, so the wheel would stay up eating mouse moves');
check('leaving first person closes the wheel', /function exitFPS[\s\S]{0,300}closeCommandWheel\(false\)/.test(src));
check('right mouse still aims down sights', /e\.button === 2\) \{ localAimTarget = 1/.test(src));

console.log('\ncommand wheel: the order actually reaches the FSM');
check('movement runs in the out-of-combat chain', /else if \(updateCommandMovement\(nowMs\)\)/.test(src));
check('it runs after packs and before formation',
  /updatePackSeekMovement\(nowMs\)\)[\s\S]{0,120}updateCommandMovement\(nowMs\)\)[\s\S]{0,120}updateSquadFormationMovement\(nowMs\)\)/.test(src),
  'ordering is the harness contract: a heal outranks an order, an order outranks a formation slot');
check('break contact feeds the activity ctx', /c\.orderOverride = liveOrder\?\.breakContact === true/.test(src),
  'without this the flag is inert -- bot-activity.js only drops a fight on ctx.orderOverride');
check('double time feeds the stance ctx', /sc\.doubleTime = liveOrder\?\.doubleTime === true/.test(src),
  'without this the flag is inert -- bot-stance.js only returns STANCE_RUN on ctx.doubleTime');
check('both flags reach squadmates, not just the addressed bot',
  /function orderFor\(rec\)[\s\S]{0,200}resolveOrderFor\(orderBook, rec\.id, rec\.squadId/.test(src),
  'a squad-scoped order has to resolve for every member, or only the leader runs or breaks contact');

console.log('\ncommand wheel: order lifecycle');
check("a 'move' order clears on arrival, a 'hold' order does not",
  /if \(!completeOrder\(orderBook, order\)\) return true;/.test(src),
  'completeOrder deletes a move and latches a hold -- both branches hang off that one return');
check('the goal is issued from the ground point under the crosshair',
  /lgRaycastTerrain\(\)[\s\S]{0,200}commandBotTo\(pick, hit\)/.test(src));
check('issuing drops the mover\'s current path so the order takes effect at once',
  /if \(mover\) mover\.pathMode = null;/.test(src));
check('a commanded bot answers out loud', /announceOrder\(botPlayers\.get\(moverId\) \?\? rec\)/.test(src)
  && /order_ack_squad' : 'order_ack'/.test(src));

console.log('\norders: plurality, addressing, lifecycle');
check('there is no single global command slot left',
  !/let commandTargetId/.test(src) && !/let commandGoal\b/.test(src),
  'one target id means ordering a second squad silently erases the first order');
check('orders are addressed to the squad when the picked bot is in one',
  /scope: toSquad \? SCOPE_SQUAD : SCOPE_BOT/.test(src));
check('"this bot only" still detaches a single body',
  /const toSquad = !!squad && !commandBotOnly/.test(src) && /id: 'botOnly'/.test(src));
check('only the mover walks the goal; the rest ride their formation slots',
  /orderMoverId\(order, activeBot\.squadId[\s\S]{0,80}!== activeBot\.id\) return false/.test(src));
check('dead addressees are pruned every tick, not only on arrival',
  /pruneOrderBook\(nowMs\)/.test(src) && /updateSquads\(nowMs\);[\s\S]{0,140}pruneOrderBook\(nowMs\)/.test(src),
  'this is the dead-commander bug: a hold on a dead bot used to keep its squad break-contacting forever');
check('a squad order survives its leader, because the squad is what is addressed',
  /hasSquad: id => squads\.has\(id\)/.test(src));
check('orders are inherited when squads merge', /transferOrderOnMerge\(orderBook, into\.id, from\.id\)/.test(src));
check('orders are inherited when a detachment splits off',
  /inheritOrderForNewSquad\(orderBook, born\.id/.test(src));
check('every live order draws its own marker',
  /function updateOrderMarkers[\s\S]{0,400}for \(const order of orderBook\.orders\.values\(\)\)/.test(src),
  'one shared marker would show only the newest order and hide every other one');
check('the wheel reports why a squad is not complying',
  /describeCompliance\(live/.test(src),
  'an order being obeyed and an order never heard look identical without this');

console.log(failures ? `\ncommand wheel: ${failures} FAILED` : '\ncommand wheel: all checks passed');
process.exit(failures ? 1 : 0);
