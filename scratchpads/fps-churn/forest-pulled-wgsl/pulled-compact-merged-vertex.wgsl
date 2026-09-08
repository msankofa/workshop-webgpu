// Three.js r184 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_92996Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_92996 : NodeBuffer_92996Struct;

struct NodeBuffer_92937Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_92937 : NodeBuffer_92937Struct;

struct NodeBuffer_92994Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_92994 : NodeBuffer_92994Struct;

struct NodeBuffer_92995Struct {
	value : array< u32 >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_92995 : NodeBuffer_92995Struct;

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
var<private> nodeVar0 : vec3<f32>;
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
var<private> nodeVar16 : u32;
var<private> nodeVar17 : u32;
var<private> nodeVar18 : u32;
var<private> nodeVar19 : u32;
var<private> nodeVar20 : u32;
var<private> nodeVar21 : u32;
var<private> nodeVar22 : u32;
var<private> nodeVar23 : u32;
var<private> nodeVar24 : u32;
var<private> nodeVar25 : u32;
var<private> nodeVar26 : vec2<f32>;
var<private> normalLocal : vec3<f32>;
var<private> nodeVar65 : f32;
var<private> nodeVar66 : f32;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar166 : vec4<f32>;
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
	nodeVar2 = ( nodeVar1 < NodeBuffer_92996.value[ 18u ] );

	if ( nodeVar2 ) {


		if ( nodeVar2 ) {


			if ( ( nodeVar1 >= NodeBuffer_92996.value[ 13u ] ) ) {

				nodeVar4 = 1u;

			} else {

				nodeVar4 = 0u;

			}


			if ( ( nodeVar1 >= NodeBuffer_92996.value[ 14u ] ) ) {

				nodeVar5 = 1u;

			} else {

				nodeVar5 = 0u;

			}


			if ( ( nodeVar1 >= NodeBuffer_92996.value[ 15u ] ) ) {

				nodeVar6 = 1u;

			} else {

				nodeVar6 = 0u;

			}


			if ( ( nodeVar1 >= NodeBuffer_92996.value[ 16u ] ) ) {

				nodeVar7 = 1u;

			} else {

				nodeVar7 = 0u;

			}


			if ( ( nodeVar1 >= NodeBuffer_92996.value[ 17u ] ) ) {

				nodeVar8 = 1u;

			} else {

				nodeVar8 = 0u;

			}

			nodeVar3 = min( ( ( ( ( ( 0u + nodeVar4 ) + nodeVar5 ) + nodeVar6 ) + nodeVar7 ) + nodeVar8 ), 5u );

		} else {

			nodeVar3 = 0u;

		}


		if ( nodeVar2 ) {

			nodeVar9 = ( nodeVar1 - NodeBuffer_92996.value[ ( 12u + nodeVar3 ) ] );

		} else {

			nodeVar9 = 0u;

		}

		nodeVar10 = max( NodeBuffer_92996.value[ ( ( nodeVar3 * 2u ) + 1u ) ], 1u );
		nodeVar11 = min( ( nodeVar9 / nodeVar10 ), 15u );
		nodeVar12 = ( ( ( ( nodeVar3 * 64u ) + 32u ) + nodeVar11 ) * 2u );
		nodeVar13 = cos( NodeBuffer_92937.value[ ( nodeVar12 + 1u ) ].x );
		nodeVar14 = sin( NodeBuffer_92937.value[ ( nodeVar12 + 1u ) ].x );
		nodeVar15 = ( NodeBuffer_92937.value[ nodeVar12 ].w * object.nodeUniform4 );
		nodeVar0 = vec3<f32>( ( NodeBuffer_92937.value[ nodeVar12 ].x + ( ( ( NodeBuffer_92994.value[ ( ( ( nodeVar3 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar3 * 8325u ) + min( ( nodeVar9 - ( nodeVar11 * nodeVar10 ) ), 8324u ) ) ] ) * 3u ) ].x * nodeVar13 ) + ( NodeBuffer_92994.value[ ( ( ( nodeVar3 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar3 * 8325u ) + min( ( nodeVar9 - ( nodeVar11 * nodeVar10 ) ), 8324u ) ) ] ) * 3u ) ].z * nodeVar14 ) ) * nodeVar15 ) ), ( NodeBuffer_92937.value[ nodeVar12 ].y + ( NodeBuffer_92994.value[ ( ( ( nodeVar3 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar3 * 8325u ) + min( ( nodeVar9 - ( nodeVar11 * nodeVar10 ) ), 8324u ) ) ] ) * 3u ) ].y * nodeVar15 ) ), ( NodeBuffer_92937.value[ nodeVar12 ].z + ( ( ( NodeBuffer_92994.value[ ( ( ( nodeVar3 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar3 * 8325u ) + min( ( nodeVar9 - ( nodeVar11 * nodeVar10 ) ), 8324u ) ) ] ) * 3u ) ].z * nodeVar13 ) - ( NodeBuffer_92994.value[ ( ( ( nodeVar3 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar3 * 8325u ) + min( ( nodeVar9 - ( nodeVar11 * nodeVar10 ) ), 8324u ) ) ] ) * 3u ) ].x * nodeVar14 ) ) * nodeVar15 ) ) );

	} else {

		nodeVar0 = vec3<f32>( 0.0, 0.0, 0.0 );

	}

	positionLocal = nodeVar0;

	if ( nodeVar2 ) {


		if ( ( nodeVar1 >= NodeBuffer_92996.value[ 13u ] ) ) {

			nodeVar17 = 1u;

		} else {

			nodeVar17 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92996.value[ 14u ] ) ) {

			nodeVar18 = 1u;

		} else {

			nodeVar18 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92996.value[ 15u ] ) ) {

			nodeVar19 = 1u;

		} else {

			nodeVar19 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92996.value[ 16u ] ) ) {

			nodeVar20 = 1u;

		} else {

			nodeVar20 = 0u;

		}


		if ( ( nodeVar1 >= NodeBuffer_92996.value[ 17u ] ) ) {

			nodeVar21 = 1u;

		} else {

			nodeVar21 = 0u;

		}

		nodeVar16 = min( ( ( ( ( ( 0u + nodeVar17 ) + nodeVar18 ) + nodeVar19 ) + nodeVar20 ) + nodeVar21 ), 5u );

	} else {

		nodeVar16 = 0u;

	}


	if ( nodeVar2 ) {

		nodeVar22 = ( nodeVar1 - NodeBuffer_92996.value[ ( 12u + nodeVar16 ) ] );

	} else {

		nodeVar22 = 0u;

	}

	nodeVar23 = max( NodeBuffer_92996.value[ ( ( nodeVar16 * 2u ) + 1u ) ], 1u );
	nodeVar24 = min( ( nodeVar22 / nodeVar23 ), 15u );
	nodeVar25 = ( ( ( nodeVar16 * 2313u ) + NodeBuffer_92995.value[ ( ( nodeVar16 * 8325u ) + min( ( nodeVar22 - ( nodeVar24 * nodeVar23 ) ), 8324u ) ) ] ) * 3u );
	varyings.v_pulledColor = NodeBuffer_92994.value[ ( nodeVar25 + 2u ) ].xyz;
	nodeVar26 = vec2<f32>( NodeBuffer_92994.value[ nodeVar25 ].w, NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].w );
	varyings.v_pulledUv = nodeVar26;
	normalLocal = normal;
	varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform9 * normalLocal ), 0.0 ) ).xyz );
	nodeVar65 = cos( NodeBuffer_92937.value[ ( ( ( ( ( nodeVar16 * 64u ) + 32u ) + nodeVar24 ) * 2u ) + 1u ) ].x );
	nodeVar66 = sin( NodeBuffer_92937.value[ ( ( ( ( ( nodeVar16 * 64u ) + 32u ) + nodeVar24 ) * 2u ) + 1u ) ].x );
	varyings.v_pulledNormal = vec3<f32>( ( ( NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].x * nodeVar65 ) + ( NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].z * nodeVar66 ) ), NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].y, ( ( NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].z * nodeVar65 ) - ( NodeBuffer_92994.value[ ( nodeVar25 + 1u ) ].x * nodeVar66 ) ) );
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform16 );
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - v_positionView );
	VERTEX_nodeVar166 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar166;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
