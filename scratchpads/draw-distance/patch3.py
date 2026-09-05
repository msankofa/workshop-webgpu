import io
p='base-game.html'
s=io.open(p,encoding='utf-8',newline='').read()
CR=chr(13)+chr(10); LF=chr(10); nl=CR if CR in s else LF
def rep(a,b):
    global s
    a=a.replace(LF,nl); b=b.replace(LF,nl)
    assert s.count(a)==1,(a[:70],s.count(a)); s=s.replace(a,b)
rep("""function overcastAmount() {
  return Math.min(1, settings.weatherOvercast + settings.weatherRain * settings.overcastPerRain);""",
"""// The strength the atmosphere responds to. The fog link is the look of 100% weather without the
// rain: lid, fog, sun dimming and ambient lift all read full strength, while drops, wet ground and
// lightning still read the weather slider.
function atmosphereStrength() {
  return settings.drawDistanceFog && settings.drawDistance > 0 ? 1 : settings.weatherRain;
}
function overcastAmount() {
  return Math.min(1, settings.weatherOvercast + atmosphereStrength() * settings.overcastPerRain);""")
rep("""  // The fog link is the weather fog at full strength, whatever the weather is doing: the same
  // density and sky-tracked colour that a 100% storm gives, rather than a number from the ceiling.
  const linked = settings.drawDistanceFog && settings.drawDistance > 0 ? settings.weatherFogBase + settings.weatherFogPerRain : 0;
  const density = Math.max(linked, settings.weatherFogEnabled ? settings.weatherFogBase + settings.weatherRain * settings.weatherFogPerRain : 0)""",
"""  const density = (settings.weatherFogEnabled ? settings.weatherFogBase + atmosphereStrength() * settings.weatherFogPerRain : 0)""")
rep("  const weatherDim = 1 - settings.sunDimPerRain * settings.weatherRain;",
    "  const weatherDim = 1 - settings.sunDimPerRain * atmosphereStrength();")
rep("  rig.ambLight.intensity = ambientBase * (1 + settings.ambientLiftPerRain * settings.weatherRain);",
    "  rig.ambLight.intensity = ambientBase * (1 + settings.ambientLiftPerRain * atmosphereStrength());")
io.open(p,'w',encoding='utf-8',newline='').write(s)

p='docs/subsystems/base-game.md'
s=io.open(p,encoding='utf-8',newline='').read()
rep("""(`drawDistanceFog`) applies the weather fog at full strength (`weatherFogBase + weatherFogPerRain`,
sky-tracked colour) whatever the weather is doing, because that is the fog that looked right; a
density derived from the ceiling was denser and read wrong. The far edge can still show past the
haze on a large ceiling.""",
"""(`drawDistanceFog`) is the atmosphere of 100% weather without the rain: `atmosphereStrength()`
reads 1 instead of `weatherRain` for the overcast lid, the fog density, the sun dimming and the
ambient lift, so the sky, both cloud decks and the fog share the lid's grey the way they do in a
storm. Drops, wet ground and lightning still follow the weather slider. A density derived from the
ceiling was tried first and read wrong. The far edge can still show past the haze on a large
ceiling.""")
io.open(p,'w',encoding='utf-8',newline='').write(s)
log='agent_log.csv'
t=io.open(log,encoding='utf-8',newline='').read()
lnl=CR if t.endswith(CR) else LF
if not t.endswith(lnl): t+=lnl
t+='2026-09-05T17:40,entry,"base-game.html;docs/subsystems/base-game.md",The fog link is now the whole 100% weather atmosphere without the rain (lid fog sun dim ambient lift through atmosphereStrength) since the storm look the user liked is the lid tinting clouds and fog alike not the density alone.'+lnl
io.open(log,'w',encoding='utf-8',newline='').write(t)
print('ok')
