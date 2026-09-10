// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_913Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_913 : NodeBuffer_913Struct;

struct objectStruct {
	nodeUniform1 : u32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : vec3<f32>,
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
	@location( 0 ) v_normalViewGeometry : vec3<f32>,
	@location( 1 ) v_forestNormal : vec3<f32>,
	@location( 2 ) v_positionViewDirection : vec3<f32>,
	@location( 3 ) nodeVarying7 : vec4<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar0 : u32;
var<private> nodeVar1 : f32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> normalLocal : vec3<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar104 : vec4<f32>;
var<private> positionLocal : vec3<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes


@vertex
fn main( @builtin( instance_index ) instanceIndex : u32,
	@location( 0 ) position : vec3<f32>,
	@location( 1 ) color : vec3<f32>,
	@location( 2 ) normal : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	positionLocal = position;
	nodeVar0 = ( ( object.nodeUniform1 + instanceIndex ) * 2u );
	nodeVar1 = cos( NodeBuffer_913.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar2 = sin( NodeBuffer_913.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar3 = ( NodeBuffer_913.value[ nodeVar0 ].w * ( object.nodeUniform2 * object.nodeUniform3 ) );
	positionLocal = vec3<f32>( ( NodeBuffer_913.value[ nodeVar0 ].x + ( ( ( positionLocal.x * nodeVar1 ) + ( positionLocal.z * nodeVar2 ) ) * nodeVar3 ) ), ( NodeBuffer_913.value[ nodeVar0 ].y + ( positionLocal.y * nodeVar3 ) ), ( NodeBuffer_913.value[ nodeVar0 ].z + ( ( ( positionLocal.z * nodeVar1 ) - ( positionLocal.x * nodeVar2 ) ) * nodeVar3 ) ) );
	varyings.nodeVarying7 = vec4<f32>( color, 1.0 );
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform9 * normalLocal ), 0.0 ) ).xyz );
	varyings.v_forestNormal = vec3<f32>( ( ( normalLocal.x * nodeVar1 ) + ( normalLocal.z * nodeVar2 ) ), normalLocal.y, ( ( normalLocal.z * nodeVar1 ) - ( normalLocal.x * nodeVar2 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform16 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar104 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar104;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
