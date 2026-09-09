// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_5504Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_5504 : NodeBuffer_5504Struct;

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
	nodeUniform13 : u32,
	nodeUniform18 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
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
	@location( 0 ) v_normalViewGeometry : vec3<f32>,
	@location( 1 ) v_positionViewDirection : vec3<f32>,
	@location( 2 ) nodeVarying6 : vec4<f32>,
	@location( 3 ) nodeVarying7 : vec3<f32>,
	@location( 4 ) @interpolate(flat, either) nodeVarying8 : u32,
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
var<private> VERTEX_nodeVar106 : vec4<f32>;
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
	nodeVar1 = cos( NodeBuffer_5504.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar2 = sin( NodeBuffer_5504.value[ ( nodeVar0 + 1u ) ].x );
	nodeVar3 = ( NodeBuffer_5504.value[ nodeVar0 ].w * ( object.nodeUniform2 * object.nodeUniform3 ) );
	positionLocal = vec3<f32>( ( NodeBuffer_5504.value[ nodeVar0 ].x + ( ( ( positionLocal.x * nodeVar1 ) + ( positionLocal.z * nodeVar2 ) ) * nodeVar3 ) ), ( NodeBuffer_5504.value[ nodeVar0 ].y + ( positionLocal.y * nodeVar3 ) ), ( NodeBuffer_5504.value[ nodeVar0 ].z + ( ( ( positionLocal.z * nodeVar1 ) - ( positionLocal.x * nodeVar2 ) ) * nodeVar3 ) ) );
	varyings.nodeVarying6 = vec4<f32>( color, 1.0 );
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform9 * normalLocal ), 0.0 ) ).xyz );
	varyings.nodeVarying7 = normal;
	varyings.nodeVarying8 = instanceIndex;
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform18 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar106 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar106;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
