// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_1265Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_1265 : NodeBuffer_1265Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : vec2<f32>,
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : vec2<f32>,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : vec2<f32>,
	nodeUniform16 : f32,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : f32,
	nodeUniform21 : f32,
	nodeUniform22 : f32,
	nodeUniform23 : f32,
	nodeUniform24 : vec2<f32>,
	nodeUniform25 : f32,
	nodeUniform26 : f32,
	nodeUniform27 : f32,
	nodeUniform28 : vec3<f32>,
	nodeUniform29 : vec3<f32>,
	nodeUniform31 : f32,
	nodeUniform32 : vec3<f32>,
	nodeUniform33 : f32,
	nodeUniform34 : f32,
	nodeUniform35 : f32,
	nodeUniform37 : vec2<f32>,
	nodeUniform38 : f32,
	nodeUniform39 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : f32,
	nodeUniform42 : f32,
	nodeUniform43 : vec2<f32>,
	nodeUniform44 : f32,
	nodeUniform45 : f32,
	nodeUniform46 : f32,
	nodeUniform47 : f32,
	nodeUniform48 : f32,
	nodeUniform49 : f32,
	nodeUniform50 : f32,
	nodeUniform52 : mat4x4<f32>,
	nodeUniform53 : vec3<f32>,
	nodeUniform54 : f32,
	nodeUniform55 : f32,
	nodeUniform57 : f32,
	nodeUniform58 : f32,
	nodeUniform59 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	cameraPosition : vec3<f32>,
	nodeUniform62 : vec3<f32>,
	nodeUniform60 : vec3<f32>,
	nodeUniform61 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) positionLocal : vec3<f32>,
	@location( 1 ) v_positionWorld : vec3<f32>,
	@location( 2 ) nodeVarying4 : vec3<f32>,
	@location( 3 ) v_positionViewDirection : vec3<f32>,
	@location( 4 ) nodeVarying7 : f32,
	@location( 5 ) nodeVarying8 : vec2<f32>,
	@location( 6 ) @interpolate(flat, either) nodeVarying9 : u32,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar0 : f32;
var<private> nodeVar1 : f32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : f32;
var<private> nodeVar14 : vec2<f32>;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : f32;
var<private> nodeVar18 : f32;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec2<f32>;
var<private> nodeVar21 : vec2<f32>;
var<private> nodeVar22 : vec2<f32>;
var<private> nodeVar23 : vec2<f32>;
var<private> nodeVar24 : vec2<f32>;
var<private> nodeVar25 : vec2<f32>;
var<private> nodeVar26 : vec2<f32>;
var<private> nodeVar27 : vec2<f32>;
var<private> nodeVar28 : vec2<f32>;
var<private> nodeVar29 : vec2<f32>;
var<private> nodeVar30 : vec2<f32>;
var<private> nodeVar31 : vec2<f32>;
var<private> nodeVar32 : vec2<f32>;
var<private> nodeVar33 : vec2<f32>;
var<private> nodeVar34 : vec2<f32>;
var<private> nodeVar35 : vec2<f32>;
var<private> nodeVar36 : vec2<f32>;
var<private> nodeVar37 : vec2<f32>;
var<private> nodeVar38 : vec2<f32>;
var<private> nodeVar39 : vec2<f32>;
var<private> nodeVar40 : vec2<f32>;
var<private> nodeVar41 : vec2<f32>;
var<private> nodeVar42 : vec2<f32>;
var<private> nodeVar43 : vec2<f32>;
var<private> nodeVar44 : vec2<f32>;
var<private> nodeVar45 : vec2<f32>;
var<private> nodeVar46 : vec2<f32>;
var<private> nodeVar47 : vec2<f32>;
var<private> nodeVar48 : vec2<f32>;
var<private> nodeVar49 : vec2<f32>;
var<private> nodeVar50 : vec2<f32>;
var<private> nodeVar51 : vec2<f32>;
var<private> nodeVar52 : vec2<f32>;
var<private> nodeVar53 : vec2<f32>;
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : f32;
var<private> nodeVar56 : vec2<f32>;
var<private> nodeVar57 : vec2<f32>;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : vec2<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar174 : vec4<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes


@vertex
fn main( @builtin( instance_index ) instanceIndex : u32,
	@location( 0 ) position : vec3<f32>,
	@location( 1 ) aWind : f32,
	@location( 2 ) aBladeUV : vec2<f32> ) -> VaryingsStruct {

	// flow
	// code

	varyings.positionLocal = position;
	nodeVar0 = length( vec2<f32>( ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.x - object.nodeUniform3.x ), ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.z - object.nodeUniform3.y ) ) );
	nodeVar1 = pow( clamp( ( ( nodeVar0 - object.nodeUniform4 ) / max( ( object.nodeUniform5 - object.nodeUniform4 ), 0.001 ) ), 0.0, 1.0 ), object.nodeUniform6 );
	nodeVar2 = clamp( ( ( nodeVar0 - object.nodeUniform7 ) / max( ( object.nodeUniform8 - object.nodeUniform7 ), 0.001 ) ), 0.0, 1.0 );
	nodeVar3 = ( ( varyings.positionLocal.x * object.nodeUniform1 ) * ( ( 1.0 - ( object.nodeUniform2 * nodeVar1 ) ) * nodeVar2 ) );
	nodeVar4 = cos( NodeBuffer_1265.value[ ( ( instanceIndex * 2u ) + 1u ) ].x );
	nodeVar5 = ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.x + ( nodeVar3 * nodeVar4 ) );
	nodeVar6 = ( clamp( ( aWind * 2.0 ), 0.0, 1.0 ) * mix( object.nodeUniform13, object.nodeUniform14, clamp( ( ( aWind - 0.6 ) * 10.0 ), 0.0, 1.0 ) ) );
	nodeVar7 = vec2<f32>( object.nodeUniform15.x, object.nodeUniform15.y );
	nodeVar8 = vec2<f32>( ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.x + object.nodeUniform11.x ), ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.z + object.nodeUniform11.y ) );
	nodeVar9 = vec2<f32>( ( NodeBuffer_1265.value[ ( ( instanceIndex * 2u ) + 1u ) ].x * 0.31 ), ( ( NodeBuffer_1265.value[ ( ( instanceIndex * 2u ) + 1u ) ].x * 0.77 ) + ( nodeVar8.x * 0.013 ) ) );
	nodeVar10 = fract( ( ( ( nodeVar9 * vec2<f32>( 7.31 ) ) + vec2<f32>( 0.13 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar11 = ( nodeVar10 + vec2<f32>( dot( nodeVar10, ( nodeVar10 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar12 = fract( ( nodeVar11.x * nodeVar11.y ) );
	nodeVar13 = ( ( ( dot( nodeVar8, nodeVar7 ) * object.nodeUniform12 ) + ( object.nodeUniform9 * object.nodeUniform10 ) ) + ( nodeVar12 * 6.2832 ) );
	nodeVar14 = mix( vec2<f32>( ( sin( ( ( object.nodeUniform9 * object.nodeUniform10 ) + ( ( nodeVar5 + object.nodeUniform11.x ) * object.nodeUniform12 ) ) ) * nodeVar6 ), 0.0 ), ( nodeVar7 * vec2<f32>( ( ( ( ( sin( nodeVar13 ) * 0.6 ) + ( sin( ( ( nodeVar13 * 0.5 ) + 1.7 ) ) * 0.4 ) ) + ( ( sin( ( ( object.nodeUniform9 * 8.0 ) + ( nodeVar12 * 18.85 ) ) ) * 0.15 ) * object.nodeUniform16 ) ) * nodeVar6 ) ) ), object.nodeUniform17 );
	nodeVar15 = sin( NodeBuffer_1265.value[ ( ( instanceIndex * 2u ) + 1u ) ].x );
	nodeVar16 = vec2<f32>( ( - nodeVar15 ), nodeVar4 );
	nodeVar17 = 1.0;

	if ( ( object.nodeUniform20 > 0.5 ) ) {

		nodeVar18 = mix( ( 1.0 + object.nodeUniform21 ), ( - object.nodeUniform21 ), object.nodeUniform22 );
		nodeVar19 = ( ( nodeVar8 * vec2<f32>( object.nodeUniform23 ) ) + object.nodeUniform24 );
		nodeVar20 = floor( nodeVar19 );
		nodeVar21 = fract( ( nodeVar20 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar22 = ( nodeVar21 + vec2<f32>( dot( nodeVar21, ( nodeVar21 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar23 = fract( ( ( nodeVar20 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar24 = ( nodeVar23 + vec2<f32>( dot( nodeVar23, ( nodeVar23 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar25 = fract( nodeVar19 );
		nodeVar26 = ( ( nodeVar25 * nodeVar25 ) * ( vec2<f32>( 3.0 ) - ( nodeVar25 * vec2<f32>( 2.0 ) ) ) );
		nodeVar27 = fract( ( ( nodeVar20 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar28 = ( nodeVar27 + vec2<f32>( dot( nodeVar27, ( nodeVar27 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar29 = fract( ( ( nodeVar20 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar30 = ( nodeVar29 + vec2<f32>( dot( nodeVar29, ( nodeVar29 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar31 = ( ( nodeVar19 * vec2<f32>( 2.03 ) ) + vec2<f32>( 17.1, 9.7 ) );
		nodeVar32 = floor( nodeVar31 );
		nodeVar33 = fract( ( nodeVar32 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar34 = ( nodeVar33 + vec2<f32>( dot( nodeVar33, ( nodeVar33 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar35 = fract( ( ( nodeVar32 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar36 = ( nodeVar35 + vec2<f32>( dot( nodeVar35, ( nodeVar35 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar37 = fract( nodeVar31 );
		nodeVar38 = ( ( nodeVar37 * nodeVar37 ) * ( vec2<f32>( 3.0 ) - ( nodeVar37 * vec2<f32>( 2.0 ) ) ) );
		nodeVar39 = fract( ( ( nodeVar32 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar40 = ( nodeVar39 + vec2<f32>( dot( nodeVar39, ( nodeVar39 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar41 = fract( ( ( nodeVar32 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar42 = ( nodeVar41 + vec2<f32>( dot( nodeVar41, ( nodeVar41 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar43 = ( ( nodeVar19 * vec2<f32>( 4.11 ) ) + vec2<f32>( 3.3, 41.2 ) );
		nodeVar44 = floor( nodeVar43 );
		nodeVar45 = fract( ( nodeVar44 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar46 = ( nodeVar45 + vec2<f32>( dot( nodeVar45, ( nodeVar45 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar47 = fract( ( ( nodeVar44 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar48 = ( nodeVar47 + vec2<f32>( dot( nodeVar47, ( nodeVar47 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar49 = fract( nodeVar43 );
		nodeVar50 = ( ( nodeVar49 * nodeVar49 ) * ( vec2<f32>( 3.0 ) - ( nodeVar49 * vec2<f32>( 2.0 ) ) ) );
		nodeVar51 = fract( ( ( nodeVar44 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar52 = ( nodeVar51 + vec2<f32>( dot( nodeVar51, ( nodeVar51 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar53 = fract( ( ( nodeVar44 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar54 = ( nodeVar53 + vec2<f32>( dot( nodeVar53, ( nodeVar53 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar17 = smoothstep( ( nodeVar18 - object.nodeUniform21 ), ( nodeVar18 + object.nodeUniform21 ), ( ( ( mix( mix( fract( ( nodeVar22.x * nodeVar22.y ) ), fract( ( nodeVar24.x * nodeVar24.y ) ), nodeVar26.x ), mix( fract( ( nodeVar28.x * nodeVar28.y ) ), fract( ( nodeVar30.x * nodeVar30.y ) ), nodeVar26.x ), nodeVar26.y ) * 0.5 ) + ( mix( mix( fract( ( nodeVar34.x * nodeVar34.y ) ), fract( ( nodeVar36.x * nodeVar36.y ) ), nodeVar38.x ), mix( fract( ( nodeVar40.x * nodeVar40.y ) ), fract( ( nodeVar42.x * nodeVar42.y ) ), nodeVar38.x ), nodeVar38.y ) * 0.3 ) ) + ( mix( mix( fract( ( nodeVar46.x * nodeVar46.y ) ), fract( ( nodeVar48.x * nodeVar48.y ) ), nodeVar50.x ), mix( fract( ( nodeVar52.x * nodeVar52.y ) ), fract( ( nodeVar54.x * nodeVar54.y ) ), nodeVar50.x ), nodeVar50.y ) * 0.2 ) ) );
		

	}

	nodeVar55 = ( ( ( ( varyings.positionLocal.y * ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].w / 0.8 ) ) * object.nodeUniform18 ) * ( ( 1.0 - ( object.nodeUniform19 * nodeVar1 ) ) * nodeVar2 ) ) * nodeVar17 );
	nodeVar56 = fract( ( ( ( nodeVar9 * vec2<f32>( 3.17 ) ) + vec2<f32>( 1.71 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar57 = ( nodeVar56 + vec2<f32>( dot( nodeVar56, ( nodeVar56 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar58 = ( ( ( ( object.nodeUniform25 * ( ( fract( ( nodeVar57.x * nodeVar57.y ) ) * 0.8 ) + 0.6 ) ) * object.nodeUniform26 ) * ( varyings.positionLocal.y / 0.8 ) ) + 0.00001 );
	nodeVar59 = ( nodeVar16 * vec2<f32>( ( nodeVar55 * ( ( 1.0 - cos( nodeVar58 ) ) / nodeVar58 ) ) ) );
	varyings.positionLocal = vec3<f32>( ( ( nodeVar5 + nodeVar14.x ) + nodeVar59.x ), ( ( ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.y + object.nodeUniform27 ) + nodeVar55 ) + ( ( nodeVar55 * ( sin( nodeVar58 ) / nodeVar58 ) ) - nodeVar55 ) ), ( ( ( NodeBuffer_1265.value[ ( instanceIndex * 2u ) ].xyz.z + ( nodeVar3 * nodeVar15 ) ) + nodeVar14.y ) + nodeVar59.y ) );
	varyings.nodeVarying7 = aWind;
	varyings.nodeVarying8 = aBladeUV;
	varyings.nodeVarying9 = instanceIndex;
	varyings.v_positionWorld = ( object.nodeUniform52 * vec4<f32>( varyings.positionLocal, 1.0 ) ).xyz;
	varyings.nodeVarying4 = vec3<f32>( ( nodeVar16.x * cos( nodeVar58 ) ), ( - sin( nodeVar58 ) ), ( nodeVar16.y * cos( nodeVar58 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform52 );
	v_positionView = ( modelViewMatrix * vec4<f32>( varyings.positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar174 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar174;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
