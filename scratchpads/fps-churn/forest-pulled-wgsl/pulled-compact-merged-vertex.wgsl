// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_92929Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_92929 : NodeBuffer_92929Struct;

struct NodeBuffer_92988Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_92988 : NodeBuffer_92988Struct;

struct NodeBuffer_92986Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_92986 : NodeBuffer_92986Struct;

struct NodeBuffer_92987Struct {
	value : array< u32 >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_92987 : NodeBuffer_92987Struct;

struct objectStruct {
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform9 : mat3x3<f32>,
	nodeUniform10 : vec3<f32>,
	nodeUniform11 : f32,
	nodeUniform16 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform13 : vec3<f32>,
	nodeUniform14 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) v_pulledColor : vec3<f32>,
	@location( 1 ) v_pulledUv : vec2<f32>,
	@location( 2 ) v_normalViewGeometry : vec3<f32>,
	@location( 3 ) v_pulledNormal : vec3<f32>,
	@location( 4 ) v_positionViewDirection : vec3<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar0 : u32;
var<private> nodeVar1 : u32;
var<private> nodeVar2 : bool;
var<private> nodeVar3 : u32;
var<private> nodeVar4 : u32;
var<private> nodeVar5 : u32;
var<private> nodeVar6 : u32;
var<private> nodeVar7 : u32;
var<private> nodeVar8 : u32;
var<private> nodeVar9 : u32;
var<private> nodeVar10 : u32;
var<private> nodeVar11 : u32;
var<private> nodeVar12 : u32;
var<private> nodeVar13 : f32;
var<private> nodeVar14 : f32;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : vec2<f32>;
var<private> normalLocal : vec3<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar154 : vec4<f32>;
var<private> positionLocal : vec3<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes


@vertex
fn main( @builtin( instance_index ) instanceIndex : u32,
	@builtin( vertex_index ) vertexIndex : u32,
	@location( 0 ) position : vec3<f32>,
	@location( 1 ) normal : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	positionLocal = position;
	nodeVar1 = ( ( instanceIndex * 3072u ) + vertexIndex );
	nodeVar2 = ( nodeVar1 < NodeBuffer_92988.value[ 18u ] );

	if ( nodeVar2 ) {


		if ( ( nodeVar1 >= NodeBuffer_92988.value[ 13u ] ) ) {

			nodeVar3 = 1u;

		} else {

			nodeVar3 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92988.value[ 14u ] ) ) {

			nodeVar4 = 1u;

		} else {

			nodeVar4 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92988.value[ 15u ] ) ) {

			nodeVar5 = 1u;

		} else {

			nodeVar5 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92988.value[ 16u ] ) ) {

			nodeVar6 = 1u;

		} else {

			nodeVar6 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92988.value[ 17u ] ) ) {

			nodeVar7 = 1u;

		} else {

			nodeVar7 = 0u;

		}

		nodeVar0 = ( ( ( ( ( 0u + nodeVar3 ) + nodeVar4 ) + nodeVar5 ) + nodeVar6 ) + nodeVar7 );

	} else {

		nodeVar0 = 0u;

	}


	if ( nodeVar2 ) {

		nodeVar8 = ( nodeVar1 - NodeBuffer_92988.value[ ( 12u + nodeVar0 ) ] );

	} else {

		nodeVar8 = 0u;

	}

	nodeVar9 = max( NodeBuffer_92988.value[ ( ( nodeVar0 * 2u ) + 1u ) ], 1u );
	nodeVar10 = ( nodeVar8 / nodeVar9 );
	nodeVar11 = ( ( ( ( nodeVar0 * 64u ) + 32u ) + nodeVar10 ) * 2u );
	nodeVar12 = ( ( ( nodeVar0 * 2313u ) + NodeBuffer_92987.value[ ( ( nodeVar0 * 8325u ) + ( nodeVar8 - ( nodeVar10 * nodeVar9 ) ) ) ] ) * 3u );
	nodeVar13 = cos( NodeBuffer_92929.value[ ( nodeVar11 + 1u ) ].x );
	nodeVar14 = sin( NodeBuffer_92929.value[ ( nodeVar11 + 1u ) ].x );
	nodeVar15 = ( NodeBuffer_92929.value[ nodeVar11 ].w * object.nodeUniform4 );
	positionLocal = vec3<f32>( ( NodeBuffer_92929.value[ nodeVar11 ].x + ( ( ( NodeBuffer_92986.value[ nodeVar12 ].x * nodeVar13 ) + ( NodeBuffer_92986.value[ nodeVar12 ].z * nodeVar14 ) ) * nodeVar15 ) ), ( NodeBuffer_92929.value[ nodeVar11 ].y + ( NodeBuffer_92986.value[ nodeVar12 ].y * nodeVar15 ) ), ( NodeBuffer_92929.value[ nodeVar11 ].z + ( ( ( NodeBuffer_92986.value[ nodeVar12 ].z * nodeVar13 ) - ( NodeBuffer_92986.value[ nodeVar12 ].x * nodeVar14 ) ) * nodeVar15 ) ) );
	varyings.v_pulledColor = NodeBuffer_92986.value[ ( nodeVar12 + 2u ) ].xyz;
	nodeVar16 = vec2<f32>( NodeBuffer_92986.value[ nodeVar12 ].w, NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].w );
	varyings.v_pulledUv = nodeVar16;
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform9 * normalLocal ), 0.0 ) ).xyz );
	varyings.v_pulledNormal = vec3<f32>( ( ( NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].x * nodeVar13 ) + ( NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].z * nodeVar14 ) ), NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].y, ( ( NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].z * nodeVar13 ) - ( NodeBuffer_92986.value[ ( nodeVar12 + 1u ) ].x * nodeVar14 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform16 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar154 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar154;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
