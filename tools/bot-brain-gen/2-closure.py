import re, json, sys
d = json.load(open(sys.argv[1]))
fns = {k: (v[0], v[1]) for k, v in d['fns'].items()}
decls = set(d['decls'])
stop = re.compile(r'(sfx|Sfx|play|say|Voice|voice|Fx$|Debug|Orb|Tactical|Insignia|AlertMark|Mount|ProceduralBody|Pose$|Overlay|^updateBot$|stepBotAimChannels|Wound|wound|sever|Sever|Bleed|bleed|Haywire|LimbLoss|limbMap|[dD]rone|Tracer|Bullet|Debris|pushEffect|Blast(Fx|Debris)|HealthPackMesh|ReviveKitMesh|buildRole|alertDigit|Record|record|trace|Trace|StateCode|StateDescriptor|pushBotEvent|Buttons$|killCombatBot|applyBotDamage|applyCombatDamage|reviveCombatBot|creditBotHit|emit|onBotDamaged|damageWall|onWallState|spawnDummyHitImpact|spawnWorldHealthPack|removeWorldHealthPack|dropActorHealthPacks|hpAfterHit|refineWoundHit|hitNormalFor|povHitmarker|decalY|Diagnostics|WeaponSlot|swapBotWeaponSlot|setBotEquippedWeapon|applyBotMovementSettings|stanceHeight|StanceHeight|formatBot|renderBot|^fireBotShot$|^fireBotKnife$|^detonateBlast$|^launchBotProjectile$|^releaseGrenade$|^blastExposure$|^blastRadiusFor$|^blastDamageFor$|^settleAfterBlast$|^accrueLimbDamage$|^botAirTarget$|^placeBotXZ$)')
seeds = sys.argv[2].split(',')
ident_re = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)')
closure = set(); hooks = {}; todo = list(seeds)
while todo:
    n = todo.pop()
    if n in closure or n not in fns: continue
    closure.add(n)
    for idn in set(ident_re.findall(fns[n][1])):
        if idn in fns and idn not in closure:
            if stop.search(idn): hooks.setdefault(idn, set()).add(n)
            else: todo.append(idn)
globs = {}
for n in closure:
    for idn in set(ident_re.findall(fns[n][1])):
        if idn in decls and idn not in fns: globs.setdefault(idn, set()).add(n)
print('FUNCTIONS', len(closure), sum(fns[n][1].count('\n') + 1 for n in closure), 'lines')
for n in sorted(closure, key=lambda k: fns[k][0]): print(f'  {fns[n][0]:6d} {n} ({fns[n][1].count(chr(10))+1})')
print('HOOKS (cut)', len(hooks))
for h in sorted(hooks): print(f'  {h} <- {",".join(sorted(hooks[h]))}')
print('GLOBALS', len(globs))
for g in sorted(globs, key=lambda g: -len(globs[g])): print(f'  {g}: {len(globs[g])}')
