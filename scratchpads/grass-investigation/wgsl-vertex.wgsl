// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_1080Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_1080 : NodeBuffer_1080Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : vec2<f32>,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : vec2<f32>,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : f32,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : vec2<f32>,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : vec3<f32>,
	nodeUniform21 : vec3<f32>,
	nodeUniform23 : f32,
	nodeUniform24 : vec3<f32>,
	nodeUniform26 : f32,
	nodeUniform27 : f32,
	nodeUniform28 : vec2<f32>,
	nodeUniform29 : f32,
	nodeUniform30 : f32,
	nodeUniform31 : f32,
	nodeUniform32 : f32,
	nodeUniform33 : f32,
	nodeUniform34 : f32,
	nodeUniform35 : vec2<f32>,
	nodeUniform36 : f32,
	nodeUniform37 : f32,
	nodeUniform38 : f32,
	nodeUniform39 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : f32,
	nodeUniform43 : mat4x4<f32>,
	nodeUniform44 : vec3<f32>,
	nodeUniform45 : f32,
	nodeUniform46 : f32,
	nodeUniform48 : f32,
	nodeUniform49 : f32,
	nodeUniform50 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	cameraPosition : vec3<f32>,
	nodeUniform53 : vec3<f32>,
	nodeUniform51 : vec3<f32>,
	nodeUniform52 : vec3<f32>
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
var<private> nodeVar4 : vec2<f32>;
var<private> nodeVar5 : vec2<f32>;
var<private> nodeVar6 : vec2<f32>;
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> nodeVar9 : f32;
var<private> nodeVar10 : f32;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : vec2<f32>;
var<private> nodeVar14 : f32;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec2<f32>;
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
var<private> nodeVar52 : f32;
var<private> nodeVar53 : vec2<f32>;
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : f32;
var<private> nodeVar56 : vec2<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar170 : vec4<f32>;
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
	nodeVar0 = ( varyings.positionLocal.x * object.nodeUniform1 );
	nodeVar1 = cos( NodeBuffer_1080.value[ ( ( instanceIndex * 2u ) + 1u ) ].x );
	nodeVar2 = ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].xyz.x + ( nodeVar0 * nodeVar1 ) );
	nodeVar3 = ( clamp( ( aWind * 2.0 ), 0.0, 1.0 ) * mix( object.nodeUniform6, object.nodeUniform7, clamp( ( ( aWind - 0.6 ) * 10.0 ), 0.0, 1.0 ) ) );
	nodeVar4 = vec2<f32>( object.nodeUniform8.x, object.nodeUniform8.y );
	nodeVar5 = vec2<f32>( ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].xyz.x + object.nodeUniform4.x ), ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].xyz.z + object.nodeUniform4.y ) );
	nodeVar6 = vec2<f32>( ( NodeBuffer_1080.value[ ( ( instanceIndex * 2u ) + 1u ) ].x * 0.31 ), ( ( NodeBuffer_1080.value[ ( ( instanceIndex * 2u ) + 1u ) ].x * 0.77 ) + ( nodeVar5.x * 0.013 ) ) );
	nodeVar7 = fract( ( ( ( nodeVar6 * vec2<f32>( 7.31 ) ) + vec2<f32>( 0.13 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar8 = ( nodeVar7 + vec2<f32>( dot( nodeVar7, ( nodeVar7 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar9 = fract( ( nodeVar8.x * nodeVar8.y ) );
	nodeVar10 = ( ( ( dot( nodeVar5, nodeVar4 ) * object.nodeUniform5 ) + ( object.nodeUniform2 * object.nodeUniform3 ) ) + ( nodeVar9 * 6.2832 ) );
	nodeVar11 = mix( vec2<f32>( ( sin( ( ( object.nodeUniform2 * object.nodeUniform3 ) + ( ( nodeVar2 + object.nodeUniform4.x ) * object.nodeUniform5 ) ) ) * nodeVar3 ), 0.0 ), ( nodeVar4 * vec2<f32>( ( ( ( ( sin( nodeVar10 ) * 0.6 ) + ( sin( ( ( nodeVar10 * 0.5 ) + 1.7 ) ) * 0.4 ) ) + ( ( sin( ( ( object.nodeUniform2 * 8.0 ) + ( nodeVar9 * 18.85 ) ) ) * 0.15 ) * object.nodeUniform9 ) ) * nodeVar3 ) ) ), object.nodeUniform10 );
	nodeVar12 = sin( NodeBuffer_1080.value[ ( ( instanceIndex * 2u ) + 1u ) ].x );
	nodeVar13 = vec2<f32>( ( - nodeVar12 ), nodeVar1 );
	nodeVar14 = 1.0;

	if ( ( object.nodeUniform12 > 0.5 ) ) {

		nodeVar15 = mix( ( 1.0 + object.nodeUniform13 ), ( - object.nodeUniform13 ), object.nodeUniform14 );
		nodeVar16 = ( ( nodeVar5 * vec2<f32>( object.nodeUniform15 ) ) + object.nodeUniform16 );
		nodeVar17 = floor( nodeVar16 );
		nodeVar18 = fract( ( nodeVar17 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar19 = ( nodeVar18 + vec2<f32>( dot( nodeVar18, ( nodeVar18 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar20 = fract( ( ( nodeVar17 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar21 = ( nodeVar20 + vec2<f32>( dot( nodeVar20, ( nodeVar20 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar22 = fract( nodeVar16 );
		nodeVar23 = ( ( nodeVar22 * nodeVar22 ) * ( vec2<f32>( 3.0 ) - ( nodeVar22 * vec2<f32>( 2.0 ) ) ) );
		nodeVar24 = fract( ( ( nodeVar17 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar25 = ( nodeVar24 + vec2<f32>( dot( nodeVar24, ( nodeVar24 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar26 = fract( ( ( nodeVar17 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar27 = ( nodeVar26 + vec2<f32>( dot( nodeVar26, ( nodeVar26 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar28 = ( ( nodeVar16 * vec2<f32>( 2.03 ) ) + vec2<f32>( 17.1, 9.7 ) );
		nodeVar29 = floor( nodeVar28 );
		nodeVar30 = fract( ( nodeVar29 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar31 = ( nodeVar30 + vec2<f32>( dot( nodeVar30, ( nodeVar30 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar32 = fract( ( ( nodeVar29 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar33 = ( nodeVar32 + vec2<f32>( dot( nodeVar32, ( nodeVar32 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar34 = fract( nodeVar28 );
		nodeVar35 = ( ( nodeVar34 * nodeVar34 ) * ( vec2<f32>( 3.0 ) - ( nodeVar34 * vec2<f32>( 2.0 ) ) ) );
		nodeVar36 = fract( ( ( nodeVar29 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar37 = ( nodeVar36 + vec2<f32>( dot( nodeVar36, ( nodeVar36 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar38 = fract( ( ( nodeVar29 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar39 = ( nodeVar38 + vec2<f32>( dot( nodeVar38, ( nodeVar38 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar40 = ( ( nodeVar16 * vec2<f32>( 4.11 ) ) + vec2<f32>( 3.3, 41.2 ) );
		nodeVar41 = floor( nodeVar40 );
		nodeVar42 = fract( ( nodeVar41 * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar43 = ( nodeVar42 + vec2<f32>( dot( nodeVar42, ( nodeVar42 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar44 = fract( ( ( nodeVar41 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar45 = ( nodeVar44 + vec2<f32>( dot( nodeVar44, ( nodeVar44 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar46 = fract( nodeVar40 );
		nodeVar47 = ( ( nodeVar46 * nodeVar46 ) * ( vec2<f32>( 3.0 ) - ( nodeVar46 * vec2<f32>( 2.0 ) ) ) );
		nodeVar48 = fract( ( ( nodeVar41 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar49 = ( nodeVar48 + vec2<f32>( dot( nodeVar48, ( nodeVar48 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar50 = fract( ( ( nodeVar41 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
		nodeVar51 = ( nodeVar50 + vec2<f32>( dot( nodeVar50, ( nodeVar50 + vec2<f32>( 45.32 ) ) ) ) );
		nodeVar14 = smoothstep( ( nodeVar15 - object.nodeUniform13 ), ( nodeVar15 + object.nodeUniform13 ), ( ( ( mix( mix( fract( ( nodeVar19.x * nodeVar19.y ) ), fract( ( nodeVar21.x * nodeVar21.y ) ), nodeVar23.x ), mix( fract( ( nodeVar25.x * nodeVar25.y ) ), fract( ( nodeVar27.x * nodeVar27.y ) ), nodeVar23.x ), nodeVar23.y ) * 0.5 ) + ( mix( mix( fract( ( nodeVar31.x * nodeVar31.y ) ), fract( ( nodeVar33.x * nodeVar33.y ) ), nodeVar35.x ), mix( fract( ( nodeVar37.x * nodeVar37.y ) ), fract( ( nodeVar39.x * nodeVar39.y ) ), nodeVar35.x ), nodeVar35.y ) * 0.3 ) ) + ( mix( mix( fract( ( nodeVar43.x * nodeVar43.y ) ), fract( ( nodeVar45.x * nodeVar45.y ) ), nodeVar47.x ), mix( fract( ( nodeVar49.x * nodeVar49.y ) ), fract( ( nodeVar51.x * nodeVar51.y ) ), nodeVar47.x ), nodeVar47.y ) * 0.2 ) ) );
		

	}

	nodeVar52 = ( ( ( varyings.positionLocal.y * ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].w / 0.8 ) ) * object.nodeUniform11 ) * nodeVar14 );
	nodeVar53 = fract( ( ( ( nodeVar6 * vec2<f32>( 3.17 ) ) + vec2<f32>( 1.71 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar54 = ( nodeVar53 + vec2<f32>( dot( nodeVar53, ( nodeVar53 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar55 = ( ( ( ( object.nodeUniform17 * ( ( fract( ( nodeVar54.x * nodeVar54.y ) ) * 0.8 ) + 0.6 ) ) * object.nodeUniform18 ) * ( varyings.positionLocal.y / 0.8 ) ) + 0.00001 );
	nodeVar56 = ( nodeVar13 * vec2<f32>( ( nodeVar52 * ( ( 1.0 - cos( nodeVar55 ) ) / nodeVar55 ) ) ) );
	varyings.positionLocal = vec3<f32>( ( ( nodeVar2 + nodeVar11.x ) + nodeVar56.x ), ( ( ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].xyz.y + object.nodeUniform19 ) + nodeVar52 ) + ( ( nodeVar52 * ( sin( nodeVar55 ) / nodeVar55 ) ) - nodeVar52 ) ), ( ( ( NodeBuffer_1080.value[ ( instanceIndex * 2u ) ].xyz.z + ( nodeVar0 * nodeVar12 ) ) + nodeVar11.y ) + nodeVar56.y ) );
	varyings.nodeVarying7 = aWind;
	varyings.nodeVarying8 = aBladeUV;
	varyings.nodeVarying9 = instanceIndex;
	varyings.v_positionWorld = ( object.nodeUniform43 * vec4<f32>( varyings.positionLocal, 1.0 ) ).xyz;
	varyings.nodeVarying4 = vec3<f32>( ( nodeVar13.x * cos( nodeVar55 ) ), ( - sin( nodeVar55 ) ), ( nodeVar13.y * cos( nodeVar55 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform43 );
	v_positionView = ( modelViewMatrix * vec4<f32>( varyings.positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar170 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar170;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
