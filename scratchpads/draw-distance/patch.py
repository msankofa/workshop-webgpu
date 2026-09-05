import io,sys
p='base-game.html'
s=io.open(p,encoding='utf-8',newline='').read()
def rep(a,b,n=1):
    global s
    CR=chr(13)+chr(10); LF=chr(10)
    nl=CR if CR in s else LF
    a=a.replace(LF,nl); b=b.replace(LF,nl)
    assert s.count(a)==n, (a[:60], s.count(a))
    s=s.replace(a,b)

# 1. defaults
rep("  shadowUpdateEvery: 1,\n  shadowFilter: 'soft',",
    "  shadowUpdateEvery: 1,\n  shadowFilter: 'soft',\n"
    "  // One ceiling under every draw radius, local to this machine. 0 means no ceiling.\n"
    "  drawDistance: 0,\n  drawDistanceFog: false,")
# 2. range table
rep("  shadowUpdateEvery: [1, 8],\n", "  shadowUpdateEvery: [1, 8], drawDistance: [0, 3000],\n")
# 3. helper
rep("const CAMERA_FAR_NEAR_FIELD = 600;\n",
    "const CAMERA_FAR_NEAR_FIELD = 600;\n"
    "// Each subsystem keeps its own draw radius; the ceiling only clamps it, because grass lives at\n"
    "// tens of metres and trees at hundreds, so one shared value would fit neither.\n"
    "const DRAW_CEILING_FLOOR = 40;\n"
    "function drawCeiling() { return settings.drawDistance > 0 ? Math.max(DRAW_CEILING_FLOOR, settings.drawDistance) : Infinity; }\n"
    "function underCeiling(value) { return Math.min(value, drawCeiling()); }\n")
# 4. flora
rep("'grassFrustumCull', 'grassNearKeep', 'grassShading', 'grassReceiveShadow', 'grassBufferMB', 'grassKmax', 'grassOcclusion', 'grassTerrainOccludes'];",
    "'grassFrustumCull', 'grassNearKeep', 'grassShading', 'grassReceiveShadow', 'grassBufferMB', 'grassKmax', 'grassOcclusion', 'grassTerrainOccludes', 'drawDistance'];")
rep("    grassRadius: settings.grassRadius,\n", "    grassRadius: underCeiling(settings.grassRadius),\n")
# 5. forest
rep("  'treeVerticalOffset', 'treeDrawRadius', 'treeLodR0', 'treeLodR1', 'treeLodR2',",
    "  'treeVerticalOffset', 'treeDrawRadius', 'drawDistance', 'treeLodR0', 'treeLodR1', 'treeLodR2',")
rep("  for (const key of FOREST_APPLY_KEYS) if (key !== 'treesEnabled' && key !== 'worldMode') next[key] = settings[key];\n  forest.apply(next);",
    "  for (const key of FOREST_APPLY_KEYS) if (key !== 'treesEnabled' && key !== 'worldMode') next[key] = settings[key];\n"
    "  next.treeDrawRadius = underCeiling(settings.treeDrawRadius);\n  forest.apply(next);")
# 6. far plane + terrain radius
rep("""  const wantFar = Math.max(
    terrain.farExtent > 0 ? Math.max(CAMERA_FAR_NEAR_FIELD, terrain.farExtent * 1.5) : CAMERA_FAR_NEAR_FIELD,
    clouds.farExtent,
  );""",
"""  // The ceiling wins over both, clouds included: a clipped deck sits in full fog when the fog link
  // is on, and the ceiling is the user's call when it is off.
  const wantFar = underCeiling(Math.max(
    terrain.farExtent > 0 ? Math.max(CAMERA_FAR_NEAR_FIELD, terrain.farExtent * 1.5) : CAMERA_FAR_NEAR_FIELD,
    clouds.farExtent,
  ) / 1.5) * 1.5;""")
rep("  terrain.setDrawRadius(settings.terrainDrawRadius);\n",
    "  terrain.setDrawRadius(Math.min(settings.terrainDrawRadius, Math.max(1, Math.floor(drawCeiling() / terrain.system.params.chunkSize))));\n")
# 7. shadows
rep("  const shadowEvery = Math.max(1, Math.round(settings.shadowUpdateEvery) || 1);\n",
    "  const shadowEvery = Math.max(1, Math.round(settings.shadowUpdateEvery) || 1);\n"
    "  // The shadow box is the real shadow distance; the far plane along the light stays as it is.\n"
    "  const shadowReach = underCeiling(SHADOW_REACH);\n"
    "  if (rig.dirLight.shadow.camera.right !== shadowReach) {\n"
    "    for (const light of [rig.dirLight, moonLight]) {\n"
    "      const cam = light.shadow.camera;\n"
    "      cam.left = -shadowReach; cam.right = shadowReach; cam.top = shadowReach; cam.bottom = -shadowReach;\n"
    "      cam.updateProjectionMatrix();\n"
    "    }\n"
    "    forest.apply({ treeShadowReach: shadowReach });\n"
    "  }\n")
rep("const rig = createLightingRig({ scene, ui: false });\n",
    "const SHADOW_REACH = 90;\nconst rig = createLightingRig({ scene, ui: false });\n")
# 8. fog
rep("""  const density = (settings.weatherFogEnabled ? settings.weatherFogBase + settings.weatherRain * settings.weatherFogPerRain : 0)
    * (uIR.value ? BASE_GAME_IR_FOG_SCALE : 1);""",
"""  // With the fog link on, the far plane sits at 2/density, where exp2 fog reaches 98%.
  const linked = settings.drawDistanceFog && settings.drawDistance > 0 ? 2 / (drawCeiling() * 1.5) : 0;
  const density = Math.max(linked, settings.weatherFogEnabled ? settings.weatherFogBase + settings.weatherRain * settings.weatherFogPerRain : 0)
    * (uIR.value ? BASE_GAME_IR_FOG_SCALE : 1);""")
# 9. panel
rep("addToggle(captureSec, 'frameCapSnap', 'Snap the cap to the display rate');\n",
    "addToggle(captureSec, 'frameCapSnap', 'Snap the cap to the display rate');\n"
    "addRange(captureSec, 'drawDistance', 'Draw distance ceiling', 0, 3000, 10,\n"
    "  value => value > 0 ? `${value.toFixed(0)} m` : 'no ceiling');\n"
    "addToggle(captureSec, 'drawDistanceFog', 'Fog hides the far edge');\n")
io.open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
