// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_45886Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_45886 : NodeBuffer_45886Struct;

struct NodeBuffer_45883Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_45883 : NodeBuffer_45883Struct;

struct NodeBuffer_45884Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_45884 : NodeBuffer_45884Struct;

struct NodeBuffer_45885Struct {
	value : array< u32 >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_45885 : NodeBuffer_45885Struct;

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
var<private> nodeVar2 : u32;
var<private> nodeVar3 : u32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : vec2<f32>;
var<private> normalLocal : vec3<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar145 : vec4<f32>;
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
	nodeVar1 = min( u32( NodeBuffer_45886.value[ ( nodeVar0 + 1u ) ].y ), 5u );

	if ( ( vertexIndex < NodeBuffer_45885.value[ ( ( nodeVar1 * 2u ) + 1u ) ] ) ) {

		nodeVar2 = vertexIndex;

	} else {

		nodeVar2 = 0u;

	}

	nodeVar3 = ( ( ( nodeVar1 * 2313u ) + NodeBuffer_45884.value[ ( ( nodeVar1 * 8325u ) + min( nodeVar2, 8324u ) ) ] ) * 3u );
	nodeVar4 = cos( NodeBuffer_45886.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar5 = sin( NodeBuffer_45886.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar6 = ( NodeBuffer_45886.value[ nodeVar0 ].w * object.nodeUniform4 );
	positionLocal = vec3<f32>( ( NodeBuffer_45886.value[ nodeVar0 ].x + ( ( ( NodeBuffer_45883.value[ nodeVar3 ].x * nodeVar4 ) + ( NodeBuffer_45883.value[ nodeVar3 ].z * nodeVar5 ) ) * nodeVar6 ) ), ( NodeBuffer_45886.value[ nodeVar0 ].y + ( NodeBuffer_45883.value[ nodeVar3 ].y * nodeVar6 ) ), ( NodeBuffer_45886.value[ nodeVar0 ].z + ( ( ( NodeBuffer_45883.value[ nodeVar3 ].z * nodeVar4 ) - ( NodeBuffer_45883.value[ nodeVar3 ].x * nodeVar5 ) ) * nodeVar6 ) ) );
	varyings.v_pulledColor = NodeBuffer_45883.value[ ( nodeVar3 + 2u ) ].xyz;
	nodeVar7 = vec2<f32>( NodeBuffer_45883.value[ nodeVar3 ].w, NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].w );
	varyings.v_pulledUv = nodeVar7;
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform9 * normalLocal ), 0.0 ) ).xyz );
	varyings.v_pulledNormal = vec3<f32>( ( ( NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].x * nodeVar4 ) + ( NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].z * nodeVar5 ) ), NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].y, ( ( NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].z * nodeVar4 ) - ( NodeBuffer_45883.value[ ( nodeVar3 + 1u ) ].x * nodeVar5 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform16 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar145 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar145;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
