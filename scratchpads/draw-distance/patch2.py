import io
def patch(p, pairs):
    s=io.open(p,encoding='utf-8',newline='').read()
    CR=chr(13)+chr(10); LF=chr(10); nl=CR if CR in s else LF
    for a,b in pairs:
        a=a.replace(LF,nl); b=b.replace(LF,nl)
        assert s.count(a)==1,(p,a[:70],s.count(a))
        s=s.replace(a,b)
    io.open(p,'w',encoding='utf-8',newline='').write(s)

patch('terrain-clipmap.js', [
("  let visible = true;\n",
 "  let visible = true;\n  let maxHalfExtent = Infinity;   // rings whose half-extent exceeds this stay hidden\n"),
("      lv.mesh.visible = visible && w.presentCount > 0;\n    }\n    return changed;",
 "      lv.mesh.visible = visible && w.presentCount > 0 && lv.half <= maxHalfExtent;\n    }\n    return changed;"),
("    get outerHalfExtent() { return levels[levels.length - 1].half; },",
 "    get outerHalfExtent() { let half = levels[0].half; for (const lv of levels) if (lv.half <= maxHalfExtent) half = lv.half; return half; },"),
("    setVisible(v) { visible = !!v; for (const lv of levels) lv.mesh.visible = visible && lv.window.presentCount > 0; },",
 "    setVisible(v) { visible = !!v; for (const lv of levels) lv.mesh.visible = visible && lv.window.presentCount > 0 && lv.half <= maxHalfExtent; },\n"
 "    // Cap the drawn extent: the innermost ring always draws, so nothing stops a ring already streamed.\n"
 "    setMaxHalfExtent(r) { maxHalfExtent = Math.max(levels[0].half, r ?? Infinity); this.setVisible(visible); },"),
])
patch('base-game-terrain.js', [
("    setVisible(value) { visible = !!value; applyVisibility(); },",
 "    setVisible(value) { visible = !!value; applyVisibility(); },\n"
 "    // Hide far rings past this half-extent (heightfield mode only; the cascade has no rings).\n"
 "    setFarExtentCap(r) { if (clipmap) clipmap.setMaxHalfExtent(r); },"),
])
patch('base-game.html', [
("  terrain.setDrawRadius(Math.min(",
 "  // Rings must end inside the sky dome (0.88 of the far plane): a ring beyond it sits behind the\n"
 "  // sun sprite's depth and the sun draws over the ground. 0.9x the ceiling keeps the corners in.\n"
 "  terrain.setFarExtentCap(drawCeiling() * 0.9);\n"
 "  terrain.setDrawRadius(Math.min("),
("""  // With the fog link on, the far plane sits at 2/density, where exp2 fog reaches 98%.
  const linked = settings.drawDistanceFog && settings.drawDistance > 0 ? 2 / (drawCeiling() * 1.5) : 0;""",
"""  // The fog link is the weather fog at full strength, whatever the weather is doing: the same
  // density and sky-tracked colour that a 100% storm gives, rather than a number from the ceiling.
  const linked = settings.drawDistanceFog && settings.drawDistance > 0 ? settings.weatherFogBase + settings.weatherFogPerRain : 0;"""),
])
print('ok')
