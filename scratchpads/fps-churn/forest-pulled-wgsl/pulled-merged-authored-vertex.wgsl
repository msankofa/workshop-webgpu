// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_92989Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_92989 : NodeBuffer_92989Struct;

struct NodeBuffer_92986Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_92986 : NodeBuffer_92986Struct;

struct NodeBuffer_92987Struct {
	value : array< u32 >
};
@binding( 7 ) @group( 1 )
var<storage, read> NodeBuffer_92987 : NodeBuffer_92987Struct;

struct NodeBuffer_92988Struct {
	value : array< u32 >
};
@binding( 8 ) @group( 1 )
var<storage, read> NodeBuffer_92988 : NodeBuffer_92988Struct;

struct objectStruct {
	nodeUniform4 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform10 : mat3x3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : f32,
	nodeUniform18 : mat4x4<f32>
};
@binding( 1 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform17 : vec3<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform16 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) v_pulledUv : vec2<f32>,
	@location( 1 ) v_pulledColor : vec3<f32>,
	@location( 2 ) v_normalViewGeometry : vec3<f32>,
	@location( 3 ) v_pulledWorld : vec3<f32>,
	@location( 4 ) v_pulledNormal : vec3<f32>,
	@location( 5 ) v_positionViewDirection : vec3<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar0 : u32;
var<private> nodeVar1 : u32;
var<private> nodeVar2 : u32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : vec3<f32>;
var<private> nodeVar7 : vec2<f32>;
var<private> normalLocal : vec3<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar123 : vec4<f32>;
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
	nodeVar0 = ( instanceIndex * 2u );

	if ( ( vertexIndex < NodeBuffer_92988.value[ ( ( u32( NodeBuffer_92989.value[ ( nodeVar0 + 1u ) ].y ) * 2u ) + 1u ) ] ) ) {

		nodeVar1 = vertexIndex;

	} else {

		nodeVar1 = 0u;

	}

	nodeVar2 = ( ( ( u32( NodeBuffer_92989.value[ ( nodeVar0 + 1u ) ].y ) * 2313u ) + NodeBuffer_92987.value[ ( ( u32( NodeBuffer_92989.value[ ( nodeVar0 + 1u ) ].y ) * 8325u ) + nodeVar1 ) ] ) * 3u );
	nodeVar3 = cos( NodeBuffer_92989.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar4 = sin( NodeBuffer_92989.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar5 = ( NodeBuffer_92989.value[ nodeVar0 ].w * object.nodeUniform4 );
	nodeVar6 = vec3<f32>( ( NodeBuffer_92989.value[ nodeVar0 ].x + ( ( ( NodeBuffer_92986.value[ nodeVar2 ].x * nodeVar3 ) + ( NodeBuffer_92986.value[ nodeVar2 ].z * nodeVar4 ) ) * nodeVar5 ) ), ( NodeBuffer_92989.value[ nodeVar0 ].y + ( NodeBuffer_92986.value[ nodeVar2 ].y * nodeVar5 ) ), ( NodeBuffer_92989.value[ nodeVar0 ].z + ( ( ( NodeBuffer_92986.value[ nodeVar2 ].z * nodeVar3 ) - ( NodeBuffer_92986.value[ nodeVar2 ].x * nodeVar4 ) ) * nodeVar5 ) ) );
	positionLocal = nodeVar6;
	nodeVar7 = vec2<f32>( NodeBuffer_92986.value[ nodeVar2 ].w, NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].w );
	varyings.v_pulledUv = nodeVar7;
	varyings.v_pulledColor = NodeBuffer_92986.value[ ( nodeVar2 + 2u ) ].xyz;
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform10 * normalLocal ), 0.0 ) ).xyz );
	varyings.v_pulledWorld = nodeVar6;
	varyings.v_pulledNormal = vec3<f32>( ( ( NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].x * nodeVar3 ) + ( NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].z * nodeVar4 ) ), NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].y, ( ( NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].z * nodeVar3 ) - ( NodeBuffer_92986.value[ ( nodeVar2 + 1u ) ].x * nodeVar4 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform18 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar123 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar123;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
