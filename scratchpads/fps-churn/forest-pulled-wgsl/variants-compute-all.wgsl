// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct objectStruct {
	nodeUniform1 : u32
};
@binding( 1 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform1 ) { return; }

	atomicStore( &NodeBuffer_915.value[ instanceIndex ], 0u );

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_914Struct {
	value : array< u32 >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_914 : NodeBuffer_914Struct;

struct NodeBuffer_912Struct {
	value : array< vec4<f32> >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_912 : NodeBuffer_912Struct;

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_913Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_913 : NodeBuffer_913Struct;

struct objectStruct {
	nodeUniform2 : vec2<f32>,
	nodeUniform3 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : vec2<f32>,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : f32,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : f32,
	nodeUniform17 : u32
};
@binding( 2 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : i32;
var<private> nodeVar1 : i32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : f32;
var<private> nodeVar5 : u32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : f32;
var<private> nodeVar8 : u32;
var<private> nodeVar9 : u32;
var<private> nodeVar10 : u32;

// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform17 ) { return; }

	nodeVar0 = ( i32( instanceIndex ) % 16 );
	nodeVar1 = ( ( i32( instanceIndex ) - nodeVar0 ) / 16 );

	if ( ( nodeVar0 < i32( NodeBuffer_914.value[ nodeVar1 ] ) ) ) {

		nodeVar2 = ( NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ].x - object.nodeUniform2.x );
		nodeVar3 = ( NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ].z - object.nodeUniform2.y );
		nodeVar4 = ( ( nodeVar2 * nodeVar2 ) + ( nodeVar3 * nodeVar3 ) );

		if ( ( ( nodeVar4 <= ( object.nodeUniform3 * object.nodeUniform3 ) ) && ( object.nodeUniform3 > 0.0 ) ) ) {

			let nodeConst0 = atomicAdd( &NodeBuffer_915.value[ u32( ( ( nodeVar1 * 4 ) + 3 ) ) ], 1u );
			nodeVar5 = ( ( u32( ( ( nodeVar1 * 64 ) + 48 ) ) + nodeConst0 ) * 2u );
			NodeBuffer_913.value[ nodeVar5 ] = NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ];
			NodeBuffer_913.value[ ( nodeVar5 + 1u ) ] = NodeBuffer_912.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
			

		}

		nodeVar6 = length( vec2<f32>( nodeVar2, nodeVar3 ) );
		nodeVar7 = ( 1.0 / max( nodeVar6, 0.000001 ) );

		if ( ( ( nodeVar6 <= object.nodeUniform6 ) && ( ( ( ( ( ( nodeVar2 * nodeVar7 ) * object.nodeUniform7.x ) + ( ( nodeVar3 * nodeVar7 ) * object.nodeUniform7.y ) ) >= ( cos( ( acos( clamp( ( object.nodeUniform8 - object.nodeUniform9 ), -1.0, 1.0 ) ) + atan2( ( ( object.nodeUniform10 * NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ].w ) * object.nodeUniform11 ), max( nodeVar6, 0.000001 ) ) ) ) - object.nodeUniform12 ) ) || ( nodeVar6 < 0.000001 ) ) || ( object.nodeUniform13 < 0.5 ) ) ) ) {


			if ( ( nodeVar4 <= ( object.nodeUniform14 * object.nodeUniform14 ) ) ) {

				let nodeConst1 = atomicAdd( &NodeBuffer_915.value[ u32( ( nodeVar1 * 4 ) ) ], 1u );
				nodeVar8 = ( ( u32( ( nodeVar1 * 64 ) ) + nodeConst1 ) * 2u );
				NodeBuffer_913.value[ nodeVar8 ] = NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ];
				NodeBuffer_913.value[ ( nodeVar8 + 1u ) ] = NodeBuffer_912.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
				

			} else {


				if ( ( nodeVar4 <= ( object.nodeUniform15 * object.nodeUniform15 ) ) ) {

					let nodeConst2 = atomicAdd( &NodeBuffer_915.value[ u32( ( ( nodeVar1 * 4 ) + 1 ) ) ], 1u );
					nodeVar9 = ( ( u32( ( ( nodeVar1 * 64 ) + 16 ) ) + nodeConst2 ) * 2u );
					NodeBuffer_913.value[ nodeVar9 ] = NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ];
					NodeBuffer_913.value[ ( nodeVar9 + 1u ) ] = NodeBuffer_912.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
					

				} else {


					if ( ( nodeVar4 <= ( object.nodeUniform16 * object.nodeUniform16 ) ) ) {

						let nodeConst3 = atomicAdd( &NodeBuffer_915.value[ u32( ( ( nodeVar1 * 4 ) + 2 ) ) ], 1u );
						nodeVar10 = ( ( u32( ( ( nodeVar1 * 64 ) + 32 ) ) + nodeConst3 ) * 2u );
						NodeBuffer_913.value[ nodeVar10 ] = NodeBuffer_912.value[ ( i32( instanceIndex ) * 2 ) ];
						NodeBuffer_913.value[ ( nodeVar10 + 1u ) ] = NodeBuffer_912.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
						

					}

					

				}

				

			}

			

		}

		

	}


	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_916Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_916 : NodeBuffer_916Struct;

struct NodeBuffer_917Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_917 : NodeBuffer_917Struct;

struct NodeBuffer_918Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_918 : NodeBuffer_918Struct;

struct NodeBuffer_919Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_919 : NodeBuffer_919Struct;

struct NodeBuffer_920Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_920 : NodeBuffer_920Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 0u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 1u ] );
	NodeBuffer_916.value[ 1u ] = nodeConst0;
	NodeBuffer_917.value[ 1u ] = nodeConst0;
	NodeBuffer_918.value[ 1u ] = nodeConst0;
	NodeBuffer_919.value[ 1u ] = nodeConst1;
	NodeBuffer_920.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_925Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_925 : NodeBuffer_925Struct;

struct NodeBuffer_926Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_926 : NodeBuffer_926Struct;

struct NodeBuffer_927Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_927 : NodeBuffer_927Struct;

struct NodeBuffer_928Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_928 : NodeBuffer_928Struct;

struct NodeBuffer_929Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_929 : NodeBuffer_929Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 4u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 5u ] );
	NodeBuffer_925.value[ 1u ] = nodeConst0;
	NodeBuffer_926.value[ 1u ] = nodeConst0;
	NodeBuffer_927.value[ 1u ] = nodeConst0;
	NodeBuffer_928.value[ 1u ] = nodeConst1;
	NodeBuffer_929.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_934Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_934 : NodeBuffer_934Struct;

struct NodeBuffer_935Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_935 : NodeBuffer_935Struct;

struct NodeBuffer_936Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_936 : NodeBuffer_936Struct;

struct NodeBuffer_937Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_937 : NodeBuffer_937Struct;

struct NodeBuffer_938Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_938 : NodeBuffer_938Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 8u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 9u ] );
	NodeBuffer_934.value[ 1u ] = nodeConst0;
	NodeBuffer_935.value[ 1u ] = nodeConst0;
	NodeBuffer_936.value[ 1u ] = nodeConst0;
	NodeBuffer_937.value[ 1u ] = nodeConst1;
	NodeBuffer_938.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_943Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_943 : NodeBuffer_943Struct;

struct NodeBuffer_944Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_944 : NodeBuffer_944Struct;

struct NodeBuffer_945Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_945 : NodeBuffer_945Struct;

struct NodeBuffer_946Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_946 : NodeBuffer_946Struct;

struct NodeBuffer_947Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_947 : NodeBuffer_947Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 12u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 13u ] );
	NodeBuffer_943.value[ 1u ] = nodeConst0;
	NodeBuffer_944.value[ 1u ] = nodeConst0;
	NodeBuffer_945.value[ 1u ] = nodeConst0;
	NodeBuffer_946.value[ 1u ] = nodeConst1;
	NodeBuffer_947.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_952Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_952 : NodeBuffer_952Struct;

struct NodeBuffer_953Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_953 : NodeBuffer_953Struct;

struct NodeBuffer_954Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_954 : NodeBuffer_954Struct;

struct NodeBuffer_955Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_955 : NodeBuffer_955Struct;

struct NodeBuffer_956Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_956 : NodeBuffer_956Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 16u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 17u ] );
	NodeBuffer_952.value[ 1u ] = nodeConst0;
	NodeBuffer_953.value[ 1u ] = nodeConst0;
	NodeBuffer_954.value[ 1u ] = nodeConst0;
	NodeBuffer_955.value[ 1u ] = nodeConst1;
	NodeBuffer_956.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_961Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_961 : NodeBuffer_961Struct;

struct NodeBuffer_962Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_962 : NodeBuffer_962Struct;

struct NodeBuffer_963Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_963 : NodeBuffer_963Struct;

struct NodeBuffer_964Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_964 : NodeBuffer_964Struct;

struct NodeBuffer_965Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_965 : NodeBuffer_965Struct;

struct objectStruct {
	nodeUniform6 : u32
};
@binding( 6 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform6 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 20u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 21u ] );
	NodeBuffer_961.value[ 1u ] = nodeConst0;
	NodeBuffer_962.value[ 1u ] = nodeConst0;
	NodeBuffer_963.value[ 1u ] = nodeConst0;
	NodeBuffer_964.value[ 1u ] = nodeConst1;
	NodeBuffer_965.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_921Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_921 : NodeBuffer_921Struct;

struct NodeBuffer_922Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_922 : NodeBuffer_922Struct;

struct NodeBuffer_923Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_923 : NodeBuffer_923Struct;

struct NodeBuffer_924Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_924 : NodeBuffer_924Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 2u ] );
	NodeBuffer_921.value[ 1u ] = nodeConst0;
	NodeBuffer_922.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 3u ] );
	NodeBuffer_923.value[ 1u ] = nodeConst1;
	NodeBuffer_924.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_930Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_930 : NodeBuffer_930Struct;

struct NodeBuffer_931Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_931 : NodeBuffer_931Struct;

struct NodeBuffer_932Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_932 : NodeBuffer_932Struct;

struct NodeBuffer_933Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_933 : NodeBuffer_933Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 6u ] );
	NodeBuffer_930.value[ 1u ] = nodeConst0;
	NodeBuffer_931.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 7u ] );
	NodeBuffer_932.value[ 1u ] = nodeConst1;
	NodeBuffer_933.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_939Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_939 : NodeBuffer_939Struct;

struct NodeBuffer_940Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_940 : NodeBuffer_940Struct;

struct NodeBuffer_941Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_941 : NodeBuffer_941Struct;

struct NodeBuffer_942Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_942 : NodeBuffer_942Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 10u ] );
	NodeBuffer_939.value[ 1u ] = nodeConst0;
	NodeBuffer_940.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 11u ] );
	NodeBuffer_941.value[ 1u ] = nodeConst1;
	NodeBuffer_942.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_948Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_948 : NodeBuffer_948Struct;

struct NodeBuffer_949Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_949 : NodeBuffer_949Struct;

struct NodeBuffer_950Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_950 : NodeBuffer_950Struct;

struct NodeBuffer_951Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_951 : NodeBuffer_951Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 14u ] );
	NodeBuffer_948.value[ 1u ] = nodeConst0;
	NodeBuffer_949.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 15u ] );
	NodeBuffer_950.value[ 1u ] = nodeConst1;
	NodeBuffer_951.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_957Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_957 : NodeBuffer_957Struct;

struct NodeBuffer_958Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_958 : NodeBuffer_958Struct;

struct NodeBuffer_959Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_959 : NodeBuffer_959Struct;

struct NodeBuffer_960Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_960 : NodeBuffer_960Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 18u ] );
	NodeBuffer_957.value[ 1u ] = nodeConst0;
	NodeBuffer_958.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 19u ] );
	NodeBuffer_959.value[ 1u ] = nodeConst1;
	NodeBuffer_960.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_915Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_915 : NodeBuffer_915Struct;

struct NodeBuffer_966Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_966 : NodeBuffer_966Struct;

struct NodeBuffer_967Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_967 : NodeBuffer_967Struct;

struct NodeBuffer_968Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_968 : NodeBuffer_968Struct;

struct NodeBuffer_969Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_969 : NodeBuffer_969Struct;

struct objectStruct {
	nodeUniform5 : u32
};
@binding( 5 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform5 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_915.value[ 22u ] );
	NodeBuffer_966.value[ 1u ] = nodeConst0;
	NodeBuffer_967.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_915.value[ 23u ] );
	NodeBuffer_968.value[ 1u ] = nodeConst1;
	NodeBuffer_969.value[ 1u ] = nodeConst1;

	

}
