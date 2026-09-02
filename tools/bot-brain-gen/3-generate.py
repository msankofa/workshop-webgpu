import re, json, sys
S = sys.argv[1]
EXTRA_HOOKS = [h for h in sys.argv[2].split(',') if h] if len(sys.argv) > 2 else []
src = open('bot-viewer-v3.html', encoding='utf-8').read()
d = json.load(open(S + '/inv.json'))
fns = {k: (v[0], v[1]) for k, v in d['fns'].items()}
txt = open(S + '/closure3.txt', encoding='utf-8').read()
closure = [l.split()[1] for l in txt.split('HOOKS')[0].splitlines() if re.match(r'^ +\d+ \w', l)]
hooks = [l.strip().split(' <-')[0] for l in txt.split('HOOKS (cut)')[1].split('GLOBALS')[0].splitlines() if l.startswith('  ')]
closure = [n for n in closure if n not in EXTRA_HOOKS]
hooks = hooks + EXTRA_HOOKS

BS = chr(92)
def strip_js(s):
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    s = re.sub(r'//[^\n]*', ' ', s)
    s = re.sub(r'`(?:' + BS + BS + r'.|[^`' + BS + BS + r'])*`', '""', s, flags=re.S)
    s = re.sub(r"'(?:" + BS + BS + r".|[^'" + BS + BS + r"\n])*'", '""', s)
    s = re.sub(r'"(?:' + BS + BS + r'.|[^"' + BS + BS + r'\n])*"', '""', s)
    s = re.sub(r'(?<=[{,(])(\s*)([A-Za-z_$][\w$]*)\s*:(?!:)', r'\1 ', s)
    s = s.replace('...', ' ')
    return s

ident_re = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)')

def locals_in(scan_text):
    local = set(re.findall(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)', scan_text))
    for m in re.finditer(r'\b(?:const|let|var)\s+([^;]*?);', scan_text):
        inner = re.sub(r'\([^()]*\)|\{[^{}]*\}|\[[^\[\]]*\]', '', m.group(1))
        local |= set(re.findall(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)', inner))
    for m in re.finditer(r'\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]', scan_text): local |= set(re.findall(r'[A-Za-z_$][\w$]*', m.group(1)))
    for m in re.finditer(r'function\s*\w*\s*\(([^)]*)\)', scan_text): local |= set(re.findall(r'[A-Za-z_$][\w$]*', m.group(1)))
    for m in re.finditer(r'\(([^()]*)\)\s*=>', scan_text): local |= set(re.findall(r'[A-Za-z_$][\w$]*', m.group(1)))
    for m in re.finditer(r'(?<![\w$])([A-Za-z_$][\w$]*)\s*=>', scan_text): local.add(m.group(1))
    for m in re.finditer(r'catch\s*\((\w+)\)', scan_text): local.add(m.group(1))
    return local

def statement_at(m):
    text = m.group(0)
    if text.count('{') > text.count('}') or text.count('[') > text.count(']') or text.count('(') > text.count(')'):
        j = m.end(); depth = text.count('{') - text.count('}') + text.count('[') - text.count(']') + text.count('(') - text.count(')')
        while depth > 0 and j < len(src):
            c = src[j]
            if c in '{[(': depth += 1
            elif c in '}])': depth -= 1
            j += 1
        text = src[m.start():j]
    return text
def declarators(text):
    inner = re.sub(r'\([^()]*\)|\{[^{}]*\}|\[[^\[\]]*\]', '', strip_js(text).split('\n')[0])
    inner = re.sub(r'^(?:const|let|var)\s+', '', inner)
    return re.findall(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|;|$)', inner)
decl_stmt = {}; decl_line = {}
for m in re.finditer(r'^(?:const|let|var)\s+[^\n]*', src, re.M):
    text = statement_at(m)
    for n in declarators(text):
        if n not in decl_stmt:
            decl_stmt[n] = text
            decl_line[n] = src.count('\n', 0, m.start()) + 1

imp = {}
for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]', src):
    for part in m.group(1).split(','):
        part = part.strip()
        if part: imp[part.split(' as ')[-1].strip()] = (m.group(2), part)

bodies = '\n'.join(fns[n][1] for n in closure)
scan = strip_js(bodies)
ids = set(ident_re.findall(scan)) | {'stepStanceWeights', 'botSeedFromId', 'getRole', 'DEFAULT_ROLE', 'REPLAN_BUDGET_PER_FRAME', 'DUMMY_MAX_HEALTH', 'nextBotId', 'deadBotActors', 'goalClaims', 'replanBudgetLeft', 'botStanceSettings', 'recentAllyHits', 'cornerMap',
    'cellNeighbors8', '_dangerNb', 'recordDanger', 'DANGER_DEATH_WEIGHT', 'cellIndexAt', 'BOT_PATROL'}
globs = sorted((i for i in ids if i in decl_stmt and i not in fns), key=lambda n: decl_line[n])

WORLD_STATE = set('''navGrid visField cornerMap patrolPoints mapCollider terrainField terrainSettings dummyTargets dummy botDrones
  rain weather visuals botProjectiles spawnMarkers scene'''.split())
SETTINGS = set(g for g in globs if g.endswith('Settings') or g in ('botAutoRefillOnReload', 'botNoAmmoEnabled', 'botSidearmEnabled',
            'botGrenadesEnabled', 'botDroneThreatEnabled', 'USE_FIELD_LOS_PREFILTER', 'BOT_MOVE_SPEED'))
JS = set('''undefined null true false Math Number String Object Array Map Set WeakMap JSON Infinity NaN console performance Date isFinite isNaN parseInt parseFloat Float32Array Float64Array Int32Array Int16Array Int8Array Uint8Array Uint16Array Uint32Array Symbol Error Boolean Promise arguments this new return if else for while do break continue switch case default function const let var of in typeof instanceof void delete throw try catch finally class extends super import export async await yield static get set'''.split())

known = set(closure) | set(hooks) | set(imp) | JS | {'THREE', 'Vec3', 'world', 'hooks', 'settings', 'groundHeight', 'weatherSightScale', 'configure'}
emitted = set(); order = []
queue = list(globs)
while queue:
    g = queue.pop(0)
    if g in ('groundHeight', 'weatherSightScale') or g in emitted: continue
    text = decl_stmt[g]
    names = declarators(text)
    emitted |= set(names)
    order.append((g, names, text))
    if not any(n in WORLD_STATE for n in names):
        st = strip_js(text)
        for u in set(ident_re.findall(st)) - set(names) - locals_in(st):
            if u in decl_stmt and u not in fns and u not in emitted and u not in known: queue.append(u)
order.sort(key=lambda t: decl_line[t[0]])
all_decl_names = set(n for _, names, _ in order for n in names)
decl_out = []; nulled = []; decl_ids = set()
for g, names, text in order:
    st = strip_js(text)
    used = set(ident_re.findall(st)) - set(names) - locals_in(st)
    unknown = sorted(u for u in used if u not in known and u not in all_decl_names)
    if re.search(r'\bTHREE\.(?!Vector3\b)', st): unknown.append('THREE.*')
    decl_ids |= used
    line = decl_line[g]
    if unknown or any(n in WORLD_STATE for n in names):
        tag = f'(initialiser dropped: needs {", ".join(unknown)})' if unknown else '(host-owned)'
        decl_out.append(f'  // v3:{line}  {tag}')
        init = 'sink' if 'THREE.*' in unknown else 'null'
        decl_out.append('  let ' + ', '.join(f'{n} = {init}' for n in names) + ';')
        if unknown: nulled.append((names, unknown))
    else:
        if any(n in SETTINGS for n in names): text = re.sub(r'^(const|var)\b', 'let', text)
        decl_out.append(f'  // v3:{line}')
        decl_out.append('  ' + text.replace('\n', '\n  '))

by_mod = {}
for n in sorted(ids | decl_ids):
    if n in imp: by_mod.setdefault(imp[n][0], []).append(imp[n][1])

out = []
out.append('''// bot-brain.js — the bot-viewer-v3 brain as a server-safe module. GENERATED from
// bot-viewer-v3.html by tools/bot-brain-gen/ (2026-08-27): the function bodies are the harness's,
// verbatim, apart from the two PATCHES the generator lists; the host surface at the bottom is
// hand-written there too. Regenerate rather than editing the bodies here. No THREE, no DOM: the
// world is injected (heightAt, raycast), effects are hooks, and the bot record is a plain capsule
// the host moves between ticks and reads back as intent (velocity, yaw, stance, fire hook).
// Plan: docs/superpowers/plans/2026-08-27-base-game-npc-bots.md.
''')
for mod in sorted(by_mod):
    if mod in ('./combat.js', './ragdoll-body.js', './ballistic-audio.js', 'three') or mod.startswith('three/'): continue
    out.append(f"import {{ {', '.join(sorted(set(by_mod[mod])))} }} from '{mod}';")
out.append('''
// Minimal Vector3 stand-in: the brain only sets, copies, adds, scales, lerps and measures.
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
}
const THREE = { Vector3: Vec3, MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, clamp: (v, a, b) => Math.max(a, Math.min(b, v)) } };
// Render-side leftovers in verbatim bodies (a debug LOS line) land here and do nothing.
const sink = new Proxy(function () {}, { get: () => sink, set: () => true, apply: () => sink });

// A bot record shaped like bot-entity.js's createBotEntity, without THREE. `spawn` is the
// ground-contact point; the brain writes velocity and yaw, and the host reads them as intent.
export function createBrainBot(id, spawn, { radius = 0.35, standHeight = 1.8, team = 'alpha' } = {}) {
  return {
    id, team, isBot: true,
    capsule: { start: new Vec3(spawn.x, spawn.y + radius, spawn.z), end: new Vec3(spawn.x, spawn.y + standHeight - radius, spawn.z), radius },
    velocity: new Vec3(), onFloor: true, yaw: 0, pitch: 0, weapon: null, tool: null, alive: true, health: 100,
  };
}

export function createBotBrain({ world, hooks = {}, settings = {} } = {}) {
''')
out.append('  // Effects the harness does inline and the host does its own way (or not at all).')
for h in hooks:
    out.append(f"  const {h} = (...a) => hooks.{h} ? hooks.{h}(...a) : undefined;")
out.append('')
out.append('  // World bindings: the ground, the sight ray, and weather.')
out.append('  const groundHeight = (x, z) => world.heightAt(x, z);')
out.append('  const weatherSightScale = () => (world.sightScale ? world.sightScale() : 1);')
out.append('')
out.append('  // Declarations lifted from bot-viewer-v3.html (line refs are 2026-08-27).')
out.extend(decl_out)
out.append('')
out.append('  function configure(patch) { for (const [k, v] of Object.entries(patch)) { if (k in setters) setters[k](v); else throw new Error(`bot-brain configure: unknown key ${k}`); } }')
out.append('  const setters = {')
settable = set()
for g, names, text in order:
    for n in names:
        if n in WORLD_STATE or n in SETTINGS or any(n in nn for nn, _ in nulled): settable.add(n)
for n in sorted(settable):
    if n == 'botAimSettings': out.append('    botAimSettings: (v) => { botAimSettings = { ...botAimSettings, ...v }; },')
    else: out.append(f'    {n}: (v) => {{ {n} = v; }},')
out.append('  };')
out.append('  configure(settings);')
out.append('')
# Hand-finish patches applied to verbatim bodies: the host's own entities (players) join the
# enemy lists and the id lookup beside the harness's practice dummies.
PATCHES = {
    'rebuildFrameEnemyLists': [(
        "    for (const target of dummyTargets) if (target.alive) _frameEnemyArrays[i].push(target);",
        "    for (const target of dummyTargets) if (target.alive) _frameEnemyArrays[i].push(target);\n"
        "    for (const target of worldEntities) if (target.alive && target.team !== _frameEnemyTeams[i]) _frameEnemyArrays[i].push(target);")],
    'combatEntityById': [(
        "  const dummyTarget = dummyTargets.find((target) => target.id === id);",
        "  const dummyTarget = dummyTargets.find((target) => target.id === id) || worldEntities.find((target) => target.id === id);")],
}
out.append('  // Host-owned entities that are not brain bots (players): targets and threats, never actors.')
out.append('  let worldEntities = [];')
out.append('')
for n in sorted(closure, key=lambda k: fns[k][0]):
    if n in ('groundHeight', 'weatherSightScale'): continue
    body = fns[n][1]
    for old, new in PATCHES.get(n, []):
        assert old in body, f'patch anchor missing in {n}'
        body = body.replace(old, new)
    out.append(f'  // v3:{fns[n][0]}')
    out.append('  ' + body.replace('\n', '\n  '))
    out.append('')
out.append('''  // ---- host surface (hand-written; not from the harness) -------------------------------------
  // The roster half of v3's spawnBots without meshes: a brain bot, its actor, the registers.
  function spawn({ id = null, team = 'alpha', roleId = DEFAULT_ROLE, weaponId = 'cz_805_bren', at, health = DUMMY_MAX_HEALTH } = {}) {
    const role = getRole(roleId);
    const entity = createBrainBot(id ?? `bot-${nextBotId++}`, at, { team });
    entity.weapon = role.weapon ?? weaponId;
    entity.primaryWeapon = entity.weapon;
    entity.sidearm = sidearmForRole(roleId, entity.weapon, botSeedFromId(entity.id));
    entity.tool = entity.weapon;
    entity.health = health;
    entity.alive = true;
    const actor = createBotActor(entity, null, roleId);
    botActors.push(actor);
    botActorById.set(actor.id, actor);
    if (!activeBotActor) bindBotActor(actor);
    return actor;
  }
  function remove(actor) {
    const i = botActors.indexOf(actor);
    if (i >= 0) botActors.splice(i, 1);
    botActorById.delete(actor.id);
    deadBotActors.delete(actor);
    goalClaims.release?.(actor.id);
    if (activeBotActor === actor) bindBotActor(botActors[0] ?? null);
  }
  // v3's updateAllBots minus rendering, physics and squads: think for every living actor. The host
  // moves the bodies between calls and reads each entity's velocity/yaw as its intent.
  function stepAll(dt, now) {
    botStateRecordFrameNow = now;
    botFrameCounter++;
    replanBudgetLeft = REPLAN_BUDGET_PER_FRAME;
    rebuildFrameEnemyLists();
    const thinkStride = botThinkStride(rebuildBotHash().length);
    refreshGrenadeThreats();
    hooks.beforeActors?.(now);
    const focus = activeBotActor;
    if (focus) commitBotActor(focus);
    for (const actor of botActors) {
      if (actor.entity.alive === false) continue;
      bindBotActor(actor);
      actor.thinkDtAcc = (actor.thinkDtAcc ?? 0) + dt;
      if (thinkStride === 1 || actor === focus || (botFrameCounter + (actor.scanPhase ?? 0)) % thinkStride === 0) {
        updateBotSentry(actor.thinkDtAcc, now);
        actor.thinkDtAcc = 0;
      }
      if (activeBotActor) {
        activeBotActor.stanceWeights = stepStanceWeights(
          activeBotActor.stanceWeights ??= { crouch01: 0, kneel01: 0, prone01: 0 },
          poseStanceFor(activeBotActor), dt, botStanceSettings);
      }
      commitBotActor(actor);
    }
    rebuildBotHash();
    bindBotActor(botActors.includes(focus) ? focus : (botActors[0] ?? null));
  }
  // The host tells the brain about a hit: v3's applyBotDamage minus wounds, FX and scoring. The
  // host has already changed target.health (it is the HP authority); this records the evidence.
  function damaged(target, attacker, amount, now) {
    if (!target) return;
    if (attacker?.alive) recordAllyHit(target, attacker, now);
    if (target.botActor && target.health > 0) beginBotHealthRetreat(target, attacker?.id ?? null, now);
    if (target.health <= 0 && target.alive !== false) killed(target, now);
  }
  // v3's killCombatBot minus ragdoll, meshes and the scoreboard.
  function killed(target, now) {
    target.alive = false;
    goalClaims.release(target.id);
    invalidateTargetMemoryAfterDeath(target, now);
    target.velocity.set(0, 0, 0);
    const actor = target.botActor;
    if (!actor) return;
    deadBotActors.add(actor);
    actor.healRequested = false;
    const diedCoverCorner = actor.coverCorner;
    actor.coverCorner = null; actor.coverThreat = null; actor.coverStartedAt = null; actor.coverMoveSince = null; actor.coverBlacklist?.clear(); actor.peek = null;
    actor.coverGate = { invalidSince: null, switchedAt: null }; actor.peekMissStreak = 0; actor.coverHoldSince = null;
    actor.coverPeekOffsetS = 0;
    const deathXZ = botXZ(target);
    actor.alertReport = null; actor.alertMarkMode = null; actor.alertWarySince = null; actor.alertScore = 0;
    actor.attention = null; actor.patrolScan = null; actor.tierPerception = null; actor.packSeekGoal = null;
    actor.medicAction = null; actor.medicTendTargetId = null; actor.poseMode = 'none';
    actor.diedAt = now;
    actor.deathXZ = { x: deathXZ.x, z: deathXZ.z };
    if (navGrid) {
      const deathCell = cellIndexAt(navGrid, deathXZ.x, deathXZ.z);
      if (deathCell >= 0) {
        const n = cellNeighbors8(deathCell, navGrid.cols, navGrid.rows, _dangerNb);
        recordDanger(botDangerField, target.team, deathCell, DANGER_DEATH_WEIGHT, now, _dangerNb, n);
      }
      if (diedCoverCorner) {
        recordDanger(botDangerField, target.team, diedCoverCorner.anchorCell, DANGER_DEATH_WEIGHT, now);
        if (diedCoverCorner.peekCell != null) recordDanger(botDangerField, target.team, diedCoverCorner.peekCell, DANGER_DEATH_WEIGHT, now);
      }
    }
    withBotActor(actor, () => { botState = BOT_PATROL; pathMode = null; currentPath = []; });
    hooks.died?.(target, actor, now);
  }
  // Respawn in place: the roster keeps the actor; the host has moved the capsule and reset health.
  function revived(target, now) {
    const actor = target.botActor;
    if (!actor) return;
    target.alive = true;
    deadBotActors.delete(actor);
    actor.diedAt = null; actor.deathXZ = null; actor.aliveSince = now;
    actor.state = BOT_PATROL; actor.path = []; actor.pathMode = null; actor.target = null;
    actor.lastKnownTarget = null; actor.lastKnownTargetMotion = null; actor.lastKnownTargetAt = null;
    actor.healRequested = false; actor.healArrived = false; actor.healThreatId = null;
    actor.reloadUntil = null; actor.reloadWeaponId = null;
    target.ammoByWeapon = null;
  }
  return {
    configure, spawn, remove, stepAll, damaged, killed, revived,
    setWorldEntities: (list) => { worldEntities = list; },
    createBotActor, bindBotActor, commitBotActor, withBotActor,
    updateBotSentry, selectBotTarget,
    actors: () => botActors, actorById: (id) => botActorById.get(id),
    // What a hook sees while it runs: the bound actor, its bot record and current target.
    bound: () => ({ actor: activeBotActor, bot, target: botTarget, state: botState, aimPoint: botHasAimPoint ? botAimPoint : null, reloadUntil: botReloadUntil }),
    aimSettings: () => ({ ...botAimSettings }),
    ammoFor: (entity, weaponId) => withBotActor(entity.botActor, () => ensureBotAmmo(weaponId ?? entity.weapon)),
    state: () => ({ navGrid, visField, cornerMap, goalClaims, botHash, botActorById, botActors, squads, recentAllyHits }),
  };
}
''')
open('bot-brain.js', 'w', encoding='utf-8').write('\n'.join(out))

declared = known | all_decl_names
local = locals_in(scan)
unresolved = sorted(i for i in ids if i not in declared and i not in local)
print('written bot-brain.js; functions', len(closure), 'hooks', len(hooks), 'decl statements', len(order))
print('NULLED initialisers:', nulled)
print('UNRESOLVED:', unresolved)
