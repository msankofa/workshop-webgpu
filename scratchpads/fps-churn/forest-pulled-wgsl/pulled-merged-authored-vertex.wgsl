// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_140436Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_140436 : NodeBuffer_140436Struct;

struct NodeBuffer_140433Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_140433 : NodeBuffer_140433Struct;

struct NodeBuffer_140434Struct {
	value : array< u32 >
};
@binding( 7 ) @group( 1 )
var<storage, read> NodeBuffer_140434 : NodeBuffer_140434Struct;

struct NodeBuffer_140435Struct {
	value : array< u32 >
};
@binding( 8 ) @group( 1 )
var<storage, read> NodeBuffer_140435 : NodeBuffer_140435Struct;

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
var<private> nodeVar3 : u32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : vec3<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> normalLocal : vec3<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar124 : vec4<f32>;
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
	nodeVar1 = min( u32( NodeBuffer_140436.value[ ( nodeVar0 + 1u ) ].y ), 5u );

	if ( ( vertexIndex < NodeBuffer_140435.value[ ( ( nodeVar1 * 2u ) + 1u ) ] ) ) {

		nodeVar2 = vertexIndex;

	} else {

		nodeVar2 = 0u;

	}

	nodeVar3 = ( ( ( nodeVar1 * 2313u ) + NodeBuffer_140434.value[ ( ( nodeVar1 * 8325u ) + min( nodeVar2, 8324u ) ) ] ) * 3u );
	nodeVar4 = cos( NodeBuffer_140436.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar5 = sin( NodeBuffer_140436.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar6 = ( NodeBuffer_140436.value[ nodeVar0 ].w * object.nodeUniform4 );
	nodeVar7 = vec3<f32>( ( NodeBuffer_140436.value[ nodeVar0 ].x + ( ( ( NodeBuffer_140433.value[ nodeVar3 ].x * nodeVar4 ) + ( NodeBuffer_140433.value[ nodeVar3 ].z * nodeVar5 ) ) * nodeVar6 ) ), ( NodeBuffer_140436.value[ nodeVar0 ].y + ( NodeBuffer_140433.value[ nodeVar3 ].y * nodeVar6 ) ), ( NodeBuffer_140436.value[ nodeVar0 ].z + ( ( ( NodeBuffer_140433.value[ nodeVar3 ].z * nodeVar4 ) - ( NodeBuffer_140433.value[ nodeVar3 ].x * nodeVar5 ) ) * nodeVar6 ) ) );
	positionLocal = nodeVar7;
	nodeVar8 = vec2<f32>( NodeBuffer_140433.value[ nodeVar3 ].w, NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].w );
	varyings.v_pulledUv = nodeVar8;
	varyings.v_pulledColor = NodeBuffer_140433.value[ ( nodeVar3 + 2u ) ].xyz;
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform10 * normalLocal ), 0.0 ) ).xyz );
	varyings.v_pulledWorld = nodeVar7;
	varyings.v_pulledNormal = vec3<f32>( ( ( NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].x * nodeVar4 ) + ( NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].z * nodeVar5 ) ), NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].y, ( ( NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].z * nodeVar4 ) - ( NodeBuffer_140433.value[ ( nodeVar3 + 1u ) ].x * nodeVar5 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform18 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar124 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar124;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
