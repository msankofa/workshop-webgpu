# Local patch to the served Three build: per-light uniform nodes are cached per light (and per shadow),
# so instanced meshes of one material share one render bind group and camera/light uniforms are
# written once per frame instead of once per object. Applied to vendor/three-0.184/three.webgpu.js.
P = 'vendor/three-0.184/three.webgpu.js'
s = open(P, encoding='utf-8').read()

def rep(o, n, count=1):
    global s
    assert s.count(o) == count, (o[:90], s.count(o))
    s = s.replace(o, n)

# ---- helpers, next to getLightData ----
rep("""function lightShadowMatrix( light ) {""",
"""// LOCAL PATCH (workshop-webgpu, 2026-09-09): light nodes are rebuilt per material build and, for an
// instanced mesh, per object (getMaterialCacheKey appends object.uuid). Each build made fresh
// uniform nodes for the light's colour, cone, cutoff and shadow parameters, so the render-group
// bind group, which _getBindGroup shares only when every uniform node is the same instance, was
// never shared: camera and light uniforms were written once per instanced object per frame
// (measured 18 writes of cameraViewMatrix a frame for one material in Base Game). Caching those
// nodes per light restores the sharing. setSharedLightUniforms( false ) gives upstream behaviour.
let sharedLightUniforms = true;
function setSharedLightUniforms( value ) { sharedLightUniforms = value !== false; }
function getSharedLightUniforms() { return sharedLightUniforms; }
function lightSharedUniform( light, key, create ) {
	if ( sharedLightUniforms !== true || ! light ) return create();
	const data = getLightData( light );
	return data[ key ] || ( data[ key ] = create() );
}
const _sharedReferenceNodes = /*@__PURE__*/ new WeakMap();
function sharedRenderReference( name, type, object ) {
	if ( sharedLightUniforms !== true || ! object ) return reference( name, type, object ).setGroup( renderGroup );
	let byKey = _sharedReferenceNodes.get( object );
	if ( byKey === undefined ) _sharedReferenceNodes.set( object, byKey = new Map() );
	const key = name + ':' + type;
	let node = byKey.get( key );
	if ( node === undefined ) byKey.set( key, node = reference( name, type, object ).setGroup( renderGroup ) );
	return node;
}

function lightShadowMatrix( light ) {""")

# ---- AnalyticLightNode: the colour uniform per light; the node's Color IS the shared uniform's value ----
rep("""		this.colorNode = ( light && light.colorNode ) || uniform( this.color ).setGroup( renderGroup );""",
"""		this.colorNode = ( light && light.colorNode ) || lightSharedUniform( light, 'colorNode', () => uniform( new Color() ).setGroup( renderGroup ) );
		if ( ! ( light && light.colorNode ) ) this.color = this.colorNode.value;""")

# ---- PointLightNode ----
rep("""		this.cutoffDistanceNode = uniform( 0 ).setGroup( renderGroup );""",
"""		this.cutoffDistanceNode = lightSharedUniform( light, 'cutoffDistanceNode', () => uniform( 0 ).setGroup( renderGroup ) );""", 2)
rep("""		this.decayExponentNode = uniform( 2 ).setGroup( renderGroup );""",
"""		this.decayExponentNode = lightSharedUniform( light, 'decayExponentNode', () => uniform( 2 ).setGroup( renderGroup ) );""")
# ---- SpotLightNode ----
rep("""		this.coneCosNode = uniform( 0 ).setGroup( renderGroup );""",
"""		this.coneCosNode = lightSharedUniform( light, 'coneCosNode', () => uniform( 0 ).setGroup( renderGroup ) );""")
rep("""		this.penumbraCosNode = uniform( 0 ).setGroup( renderGroup );""",
"""		this.penumbraCosNode = lightSharedUniform( light, 'penumbraCosNode', () => uniform( 0 ).setGroup( renderGroup ) );""")
rep("""		this.decayExponentNode = uniform( 0 ).setGroup( renderGroup );""",
"""		this.decayExponentNode = lightSharedUniform( light, 'decayExponentNode', () => uniform( 0 ).setGroup( renderGroup ) );""")
rep("""		this.colorNode = uniform( this.color ).setGroup( renderGroup );""",
"""		this.colorNode = lightSharedUniform( light, 'spotColorNode', () => uniform( new Color() ).setGroup( renderGroup ) );
		this.color = this.colorNode.value;""")
# ---- HemisphereLightNode ----
rep("""		this.groundColorNode = uniform( new Color() ).setGroup( renderGroup );""",
"""		this.groundColorNode = lightSharedUniform( light, 'groundColorNode', () => uniform( new Color() ).setGroup( renderGroup ) );""")
# ---- RectAreaLightNode ----
rep("""		this.halfHeight = uniform( new Vector3() ).setGroup( renderGroup );""",
"""		this.halfHeight = lightSharedUniform( light, 'halfHeight', () => uniform( new Vector3() ).setGroup( renderGroup ) );""")
rep("""		this.halfWidth = uniform( new Vector3() ).setGroup( renderGroup );""",
"""		this.halfWidth = lightSharedUniform( light, 'halfWidth', () => uniform( new Vector3() ).setGroup( renderGroup ) );""")

# ---- shadow parameters: one reference node per (shadow, property) ----
rep("""	const mapSize = reference( 'mapSize', 'vec2', shadow ).setGroup( renderGroup );
	const radius = reference( 'radius', 'float', shadow ).setGroup( renderGroup );""",
"""	const mapSize = sharedRenderReference( 'mapSize', 'vec2', shadow );
	const radius = sharedRenderReference( 'radius', 'float', shadow );""")
rep("""	const radius = reference( 'radius', 'float', shadow ).setGroup( renderGroup );
	const mapSize = reference( 'mapSize', 'vec2', shadow ).setGroup( renderGroup );""",
"""	const radius = sharedRenderReference( 'radius', 'float', shadow );
	const mapSize = sharedRenderReference( 'mapSize', 'vec2', shadow );""")
rep("""	const mapSize = reference( 'mapSize', 'vec2', shadow ).setGroup( renderGroup );
""",
"""	const mapSize = sharedRenderReference( 'mapSize', 'vec2', shadow );
""")
rep("""		const bias = shadow.biasNode || reference( 'bias', 'float', shadow ).setGroup( renderGroup );""",
"""		const bias = shadow.biasNode || sharedRenderReference( 'bias', 'float', shadow );""")
rep("""			const cameraNearLocal = reference( 'near', 'float', shadow.camera ).setGroup( renderGroup );
			const cameraFarLocal = reference( 'far', 'float', shadow.camera ).setGroup( renderGroup );""",
"""			const cameraNearLocal = sharedRenderReference( 'near', 'float', shadow.camera );
			const cameraFarLocal = sharedRenderReference( 'far', 'float', shadow.camera );""")
rep("""			const samples = reference( 'blurSamples', 'float', shadow ).setGroup( renderGroup );
			const radius = reference( 'radius', 'float', shadow ).setGroup( renderGroup );
			const size = reference( 'mapSize', 'vec2', shadow ).setGroup( renderGroup );""",
"""			const samples = sharedRenderReference( 'blurSamples', 'float', shadow );
			const radius = sharedRenderReference( 'radius', 'float', shadow );
			const size = sharedRenderReference( 'mapSize', 'vec2', shadow );""")
rep("""		const shadowIntensity = reference( 'intensity', 'float', shadow ).setGroup( renderGroup );
		const normalBias = reference( 'normalBias', 'float', shadow ).setGroup( renderGroup );""",
"""		const shadowIntensity = sharedRenderReference( 'intensity', 'float', shadow );
		const normalBias = sharedRenderReference( 'normalBias', 'float', shadow );""")
rep("""	const shadowCameraNear = uniform( 'float' ).setGroup( renderGroup ).onRenderUpdate( () => shadow.camera.near );
	const shadowCameraFar = uniform( 'float' ).setGroup( renderGroup ).onRenderUpdate( () => shadow.camera.far );
	const bias = reference( 'bias', 'float', shadow ).setGroup( renderGroup );""",
"""	const shadowCameraNear = sharedRenderReference( 'camera.near', 'float', shadow );
	const shadowCameraFar = sharedRenderReference( 'camera.far', 'float', shadow );
	const bias = sharedRenderReference( 'bias', 'float', shadow );""")

# ---- exports ----
rep("export { ACESFilmicToneMapping, AONode,", "export { setSharedLightUniforms, getSharedLightUniforms, ACESFilmicToneMapping, AONode,")

assert 'reference( \'mapSize\', \'vec2\', shadow ).setGroup( renderGroup )' not in s
open(P, 'w', encoding='utf-8', newline='').write(s)
print('three patched')
