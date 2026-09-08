// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

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

	atomicStore( &NodeBuffer_45828.value[ instanceIndex ], 0u );

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45887Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45887 : NodeBuffer_45887Struct;

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

	atomicStore( &NodeBuffer_45887.value[ 0u ], 0u );

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45827Struct {
	value : array< u32 >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45827 : NodeBuffer_45827Struct;

struct NodeBuffer_45825Struct {
	value : array< vec4<f32> >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45825 : NodeBuffer_45825Struct;

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45826Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45826 : NodeBuffer_45826Struct;

struct NodeBuffer_45887Struct {
	value : array< atomic<u32> >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45887 : NodeBuffer_45887Struct;

struct NodeBuffer_45886Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 0 )
var<storage, read_write> NodeBuffer_45886 : NodeBuffer_45886Struct;

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
	nodeUniform19 : u32
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
var<private> nodeVar11 : u32;

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

	if ( instanceIndex >= object.nodeUniform19 ) { return; }

	nodeVar0 = ( i32( instanceIndex ) % 16 );
	nodeVar1 = ( ( i32( instanceIndex ) - nodeVar0 ) / 16 );

	if ( ( nodeVar0 < i32( NodeBuffer_45827.value[ nodeVar1 ] ) ) ) {

		nodeVar2 = ( NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ].x - object.nodeUniform2.x );
		nodeVar3 = ( NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ].z - object.nodeUniform2.y );
		nodeVar4 = ( ( nodeVar2 * nodeVar2 ) + ( nodeVar3 * nodeVar3 ) );

		if ( ( ( nodeVar4 <= ( object.nodeUniform3 * object.nodeUniform3 ) ) && ( object.nodeUniform3 > 0.0 ) ) ) {

			let nodeConst0 = atomicAdd( &NodeBuffer_45828.value[ u32( ( ( nodeVar1 * 4 ) + 3 ) ) ], 1u );
			nodeVar5 = ( ( u32( ( ( nodeVar1 * 64 ) + 48 ) ) + nodeConst0 ) * 2u );
			NodeBuffer_45826.value[ nodeVar5 ] = NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ];
			NodeBuffer_45826.value[ ( nodeVar5 + 1u ) ] = NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
			

		}

		nodeVar6 = length( vec2<f32>( nodeVar2, nodeVar3 ) );
		nodeVar7 = ( 1.0 / max( nodeVar6, 0.000001 ) );

		if ( ( ( nodeVar6 <= object.nodeUniform6 ) && ( ( ( ( ( ( nodeVar2 * nodeVar7 ) * object.nodeUniform7.x ) + ( ( nodeVar3 * nodeVar7 ) * object.nodeUniform7.y ) ) >= ( cos( ( acos( clamp( ( object.nodeUniform8 - object.nodeUniform9 ), -1.0, 1.0 ) ) + atan2( ( ( object.nodeUniform10 * NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ].w ) * object.nodeUniform11 ), max( nodeVar6, 0.000001 ) ) ) ) - object.nodeUniform12 ) ) || ( nodeVar6 < 0.000001 ) ) || ( object.nodeUniform13 < 0.5 ) ) ) ) {


			if ( ( nodeVar4 <= ( object.nodeUniform14 * object.nodeUniform14 ) ) ) {

				let nodeConst1 = atomicAdd( &NodeBuffer_45828.value[ u32( ( nodeVar1 * 4 ) ) ], 1u );
				nodeVar8 = ( ( u32( ( nodeVar1 * 64 ) ) + nodeConst1 ) * 2u );
				NodeBuffer_45826.value[ nodeVar8 ] = NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ];
				NodeBuffer_45826.value[ ( nodeVar8 + 1u ) ] = NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
				

			} else {


				if ( ( nodeVar4 <= ( object.nodeUniform15 * object.nodeUniform15 ) ) ) {

					let nodeConst2 = atomicAdd( &NodeBuffer_45828.value[ u32( ( ( nodeVar1 * 4 ) + 1 ) ) ], 1u );
					nodeVar9 = ( ( u32( ( ( nodeVar1 * 64 ) + 16 ) ) + nodeConst2 ) * 2u );
					NodeBuffer_45826.value[ nodeVar9 ] = NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ];
					NodeBuffer_45826.value[ ( nodeVar9 + 1u ) ] = NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
					

				} else {


					if ( ( nodeVar4 <= ( object.nodeUniform16 * object.nodeUniform16 ) ) ) {

						let nodeConst3 = atomicAdd( &NodeBuffer_45828.value[ u32( ( ( nodeVar1 * 4 ) + 2 ) ) ], 1u );
						nodeVar10 = ( ( u32( ( ( nodeVar1 * 64 ) + 32 ) ) + nodeConst3 ) * 2u );
						NodeBuffer_45826.value[ nodeVar10 ] = NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ];
						NodeBuffer_45826.value[ ( nodeVar10 + 1u ) ] = NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
						let nodeConst4 = atomicAdd( &NodeBuffer_45887.value[ 0u ], 1u );

						if ( ( nodeConst4 < 96u ) ) {

							nodeVar11 = ( nodeConst4 * 2u );
							NodeBuffer_45886.value[ nodeVar11 ] = NodeBuffer_45825.value[ ( i32( instanceIndex ) * 2 ) ];
							NodeBuffer_45886.value[ ( nodeVar11 + 1u ) ] = vec4<f32>( NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ].x, f32( nodeVar1 ), NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ].z, NodeBuffer_45825.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ].w );
							

						}

						

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

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45829Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45829 : NodeBuffer_45829Struct;

struct NodeBuffer_45830Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45830 : NodeBuffer_45830Struct;

struct NodeBuffer_45831Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45831 : NodeBuffer_45831Struct;

struct NodeBuffer_45832Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45832 : NodeBuffer_45832Struct;

struct NodeBuffer_45833Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45833 : NodeBuffer_45833Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 0u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 1u ] );
	NodeBuffer_45829.value[ 1u ] = nodeConst0;
	NodeBuffer_45830.value[ 1u ] = nodeConst0;
	NodeBuffer_45831.value[ 1u ] = nodeConst0;
	NodeBuffer_45832.value[ 1u ] = nodeConst1;
	NodeBuffer_45833.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45838Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45838 : NodeBuffer_45838Struct;

struct NodeBuffer_45839Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45839 : NodeBuffer_45839Struct;

struct NodeBuffer_45840Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45840 : NodeBuffer_45840Struct;

struct NodeBuffer_45841Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45841 : NodeBuffer_45841Struct;

struct NodeBuffer_45842Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45842 : NodeBuffer_45842Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 4u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 5u ] );
	NodeBuffer_45838.value[ 1u ] = nodeConst0;
	NodeBuffer_45839.value[ 1u ] = nodeConst0;
	NodeBuffer_45840.value[ 1u ] = nodeConst0;
	NodeBuffer_45841.value[ 1u ] = nodeConst1;
	NodeBuffer_45842.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45847Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45847 : NodeBuffer_45847Struct;

struct NodeBuffer_45848Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45848 : NodeBuffer_45848Struct;

struct NodeBuffer_45849Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45849 : NodeBuffer_45849Struct;

struct NodeBuffer_45850Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45850 : NodeBuffer_45850Struct;

struct NodeBuffer_45851Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45851 : NodeBuffer_45851Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 8u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 9u ] );
	NodeBuffer_45847.value[ 1u ] = nodeConst0;
	NodeBuffer_45848.value[ 1u ] = nodeConst0;
	NodeBuffer_45849.value[ 1u ] = nodeConst0;
	NodeBuffer_45850.value[ 1u ] = nodeConst1;
	NodeBuffer_45851.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45856Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45856 : NodeBuffer_45856Struct;

struct NodeBuffer_45857Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45857 : NodeBuffer_45857Struct;

struct NodeBuffer_45858Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45858 : NodeBuffer_45858Struct;

struct NodeBuffer_45859Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45859 : NodeBuffer_45859Struct;

struct NodeBuffer_45860Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45860 : NodeBuffer_45860Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 12u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 13u ] );
	NodeBuffer_45856.value[ 1u ] = nodeConst0;
	NodeBuffer_45857.value[ 1u ] = nodeConst0;
	NodeBuffer_45858.value[ 1u ] = nodeConst0;
	NodeBuffer_45859.value[ 1u ] = nodeConst1;
	NodeBuffer_45860.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45865Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45865 : NodeBuffer_45865Struct;

struct NodeBuffer_45866Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45866 : NodeBuffer_45866Struct;

struct NodeBuffer_45867Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45867 : NodeBuffer_45867Struct;

struct NodeBuffer_45868Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45868 : NodeBuffer_45868Struct;

struct NodeBuffer_45869Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45869 : NodeBuffer_45869Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 16u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 17u ] );
	NodeBuffer_45865.value[ 1u ] = nodeConst0;
	NodeBuffer_45866.value[ 1u ] = nodeConst0;
	NodeBuffer_45867.value[ 1u ] = nodeConst0;
	NodeBuffer_45868.value[ 1u ] = nodeConst1;
	NodeBuffer_45869.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45874Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45874 : NodeBuffer_45874Struct;

struct NodeBuffer_45875Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45875 : NodeBuffer_45875Struct;

struct NodeBuffer_45876Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45876 : NodeBuffer_45876Struct;

struct NodeBuffer_45877Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45877 : NodeBuffer_45877Struct;

struct NodeBuffer_45878Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_45878 : NodeBuffer_45878Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 20u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 21u ] );
	NodeBuffer_45874.value[ 1u ] = nodeConst0;
	NodeBuffer_45875.value[ 1u ] = nodeConst0;
	NodeBuffer_45876.value[ 1u ] = nodeConst0;
	NodeBuffer_45877.value[ 1u ] = nodeConst1;
	NodeBuffer_45878.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45834Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45834 : NodeBuffer_45834Struct;

struct NodeBuffer_45835Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45835 : NodeBuffer_45835Struct;

struct NodeBuffer_45836Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45836 : NodeBuffer_45836Struct;

struct NodeBuffer_45837Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45837 : NodeBuffer_45837Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 2u ] );
	NodeBuffer_45834.value[ 1u ] = nodeConst0;
	NodeBuffer_45835.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 3u ] );
	NodeBuffer_45836.value[ 1u ] = nodeConst1;
	NodeBuffer_45837.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45843Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45843 : NodeBuffer_45843Struct;

struct NodeBuffer_45844Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45844 : NodeBuffer_45844Struct;

struct NodeBuffer_45845Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45845 : NodeBuffer_45845Struct;

struct NodeBuffer_45846Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45846 : NodeBuffer_45846Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 6u ] );
	NodeBuffer_45843.value[ 1u ] = nodeConst0;
	NodeBuffer_45844.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 7u ] );
	NodeBuffer_45845.value[ 1u ] = nodeConst1;
	NodeBuffer_45846.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45852Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45852 : NodeBuffer_45852Struct;

struct NodeBuffer_45853Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45853 : NodeBuffer_45853Struct;

struct NodeBuffer_45854Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45854 : NodeBuffer_45854Struct;

struct NodeBuffer_45855Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45855 : NodeBuffer_45855Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 10u ] );
	NodeBuffer_45852.value[ 1u ] = nodeConst0;
	NodeBuffer_45853.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 11u ] );
	NodeBuffer_45854.value[ 1u ] = nodeConst1;
	NodeBuffer_45855.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45861Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45861 : NodeBuffer_45861Struct;

struct NodeBuffer_45862Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45862 : NodeBuffer_45862Struct;

struct NodeBuffer_45863Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45863 : NodeBuffer_45863Struct;

struct NodeBuffer_45864Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45864 : NodeBuffer_45864Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 14u ] );
	NodeBuffer_45861.value[ 1u ] = nodeConst0;
	NodeBuffer_45862.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 15u ] );
	NodeBuffer_45863.value[ 1u ] = nodeConst1;
	NodeBuffer_45864.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45870Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45870 : NodeBuffer_45870Struct;

struct NodeBuffer_45871Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45871 : NodeBuffer_45871Struct;

struct NodeBuffer_45872Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45872 : NodeBuffer_45872Struct;

struct NodeBuffer_45873Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45873 : NodeBuffer_45873Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 18u ] );
	NodeBuffer_45870.value[ 1u ] = nodeConst0;
	NodeBuffer_45871.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 19u ] );
	NodeBuffer_45872.value[ 1u ] = nodeConst1;
	NodeBuffer_45873.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45828Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45828 : NodeBuffer_45828Struct;

struct NodeBuffer_45879Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45879 : NodeBuffer_45879Struct;

struct NodeBuffer_45880Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_45880 : NodeBuffer_45880Struct;

struct NodeBuffer_45881Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_45881 : NodeBuffer_45881Struct;

struct NodeBuffer_45882Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_45882 : NodeBuffer_45882Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_45828.value[ 22u ] );
	NodeBuffer_45879.value[ 1u ] = nodeConst0;
	NodeBuffer_45880.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_45828.value[ 23u ] );
	NodeBuffer_45881.value[ 1u ] = nodeConst1;
	NodeBuffer_45882.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_45887Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_45887 : NodeBuffer_45887Struct;

struct NodeBuffer_45888Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_45888 : NodeBuffer_45888Struct;

struct objectStruct {
	nodeUniform2 : u32
};
@binding( 2 ) @group( 0 )
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

	if ( instanceIndex >= object.nodeUniform2 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_45887.value[ 0u ] );
	NodeBuffer_45888.value[ 1u ] = min( nodeConst0, 96u );

	

}
