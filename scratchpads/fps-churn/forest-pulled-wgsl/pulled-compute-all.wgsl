// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

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

	atomicStore( &NodeBuffer_92931.value[ instanceIndex ], 0u );

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92930Struct {
	value : array< u32 >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92930 : NodeBuffer_92930Struct;

struct NodeBuffer_92928Struct {
	value : array< vec4<f32> >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92928 : NodeBuffer_92928Struct;

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92929Struct {
	value : array< vec4<f32> >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92929 : NodeBuffer_92929Struct;

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

	if ( ( nodeVar0 < i32( NodeBuffer_92930.value[ nodeVar1 ] ) ) ) {

		nodeVar2 = ( NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ].x - object.nodeUniform2.x );
		nodeVar3 = ( NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ].z - object.nodeUniform2.y );
		nodeVar4 = ( ( nodeVar2 * nodeVar2 ) + ( nodeVar3 * nodeVar3 ) );

		if ( ( ( nodeVar4 <= ( object.nodeUniform3 * object.nodeUniform3 ) ) && ( object.nodeUniform3 > 0.0 ) ) ) {

			let nodeConst0 = atomicAdd( &NodeBuffer_92931.value[ u32( ( ( nodeVar1 * 4 ) + 3 ) ) ], 1u );
			nodeVar5 = ( ( u32( ( ( nodeVar1 * 64 ) + 48 ) ) + nodeConst0 ) * 2u );
			NodeBuffer_92929.value[ nodeVar5 ] = NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ];
			NodeBuffer_92929.value[ ( nodeVar5 + 1u ) ] = NodeBuffer_92928.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
			

		}

		nodeVar6 = length( vec2<f32>( nodeVar2, nodeVar3 ) );
		nodeVar7 = ( 1.0 / max( nodeVar6, 0.000001 ) );

		if ( ( ( nodeVar6 <= object.nodeUniform6 ) && ( ( ( ( ( ( nodeVar2 * nodeVar7 ) * object.nodeUniform7.x ) + ( ( nodeVar3 * nodeVar7 ) * object.nodeUniform7.y ) ) >= ( cos( ( acos( clamp( ( object.nodeUniform8 - object.nodeUniform9 ), -1.0, 1.0 ) ) + atan2( ( ( object.nodeUniform10 * NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ].w ) * object.nodeUniform11 ), max( nodeVar6, 0.000001 ) ) ) ) - object.nodeUniform12 ) ) || ( nodeVar6 < 0.000001 ) ) || ( object.nodeUniform13 < 0.5 ) ) ) ) {


			if ( ( nodeVar4 <= ( object.nodeUniform14 * object.nodeUniform14 ) ) ) {

				let nodeConst1 = atomicAdd( &NodeBuffer_92931.value[ u32( ( nodeVar1 * 4 ) ) ], 1u );
				nodeVar8 = ( ( u32( ( nodeVar1 * 64 ) ) + nodeConst1 ) * 2u );
				NodeBuffer_92929.value[ nodeVar8 ] = NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ];
				NodeBuffer_92929.value[ ( nodeVar8 + 1u ) ] = NodeBuffer_92928.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
				

			} else {


				if ( ( nodeVar4 <= ( object.nodeUniform15 * object.nodeUniform15 ) ) ) {

					let nodeConst2 = atomicAdd( &NodeBuffer_92931.value[ u32( ( ( nodeVar1 * 4 ) + 1 ) ) ], 1u );
					nodeVar9 = ( ( u32( ( ( nodeVar1 * 64 ) + 16 ) ) + nodeConst2 ) * 2u );
					NodeBuffer_92929.value[ nodeVar9 ] = NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ];
					NodeBuffer_92929.value[ ( nodeVar9 + 1u ) ] = NodeBuffer_92928.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
					

				} else {


					if ( ( nodeVar4 <= ( object.nodeUniform16 * object.nodeUniform16 ) ) ) {

						let nodeConst3 = atomicAdd( &NodeBuffer_92931.value[ u32( ( ( nodeVar1 * 4 ) + 2 ) ) ], 1u );
						nodeVar10 = ( ( u32( ( ( nodeVar1 * 64 ) + 32 ) ) + nodeConst3 ) * 2u );
						NodeBuffer_92929.value[ nodeVar10 ] = NodeBuffer_92928.value[ ( i32( instanceIndex ) * 2 ) ];
						NodeBuffer_92929.value[ ( nodeVar10 + 1u ) ] = NodeBuffer_92928.value[ ( ( i32( instanceIndex ) * 2 ) + 1 ) ];
						

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

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92932Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92932 : NodeBuffer_92932Struct;

struct NodeBuffer_92933Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92933 : NodeBuffer_92933Struct;

struct NodeBuffer_92934Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92934 : NodeBuffer_92934Struct;

struct NodeBuffer_92935Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92935 : NodeBuffer_92935Struct;

struct NodeBuffer_92936Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92936 : NodeBuffer_92936Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 0u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 1u ] );
	NodeBuffer_92932.value[ 1u ] = nodeConst0;
	NodeBuffer_92933.value[ 1u ] = nodeConst0;
	NodeBuffer_92934.value[ 1u ] = nodeConst0;
	NodeBuffer_92935.value[ 1u ] = nodeConst1;
	NodeBuffer_92936.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92941Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92941 : NodeBuffer_92941Struct;

struct NodeBuffer_92942Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92942 : NodeBuffer_92942Struct;

struct NodeBuffer_92943Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92943 : NodeBuffer_92943Struct;

struct NodeBuffer_92944Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92944 : NodeBuffer_92944Struct;

struct NodeBuffer_92945Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92945 : NodeBuffer_92945Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 4u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 5u ] );
	NodeBuffer_92941.value[ 1u ] = nodeConst0;
	NodeBuffer_92942.value[ 1u ] = nodeConst0;
	NodeBuffer_92943.value[ 1u ] = nodeConst0;
	NodeBuffer_92944.value[ 1u ] = nodeConst1;
	NodeBuffer_92945.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92950Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92950 : NodeBuffer_92950Struct;

struct NodeBuffer_92951Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92951 : NodeBuffer_92951Struct;

struct NodeBuffer_92952Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92952 : NodeBuffer_92952Struct;

struct NodeBuffer_92953Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92953 : NodeBuffer_92953Struct;

struct NodeBuffer_92954Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92954 : NodeBuffer_92954Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 8u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 9u ] );
	NodeBuffer_92950.value[ 1u ] = nodeConst0;
	NodeBuffer_92951.value[ 1u ] = nodeConst0;
	NodeBuffer_92952.value[ 1u ] = nodeConst0;
	NodeBuffer_92953.value[ 1u ] = nodeConst1;
	NodeBuffer_92954.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92959Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92959 : NodeBuffer_92959Struct;

struct NodeBuffer_92960Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92960 : NodeBuffer_92960Struct;

struct NodeBuffer_92961Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92961 : NodeBuffer_92961Struct;

struct NodeBuffer_92962Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92962 : NodeBuffer_92962Struct;

struct NodeBuffer_92963Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92963 : NodeBuffer_92963Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 12u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 13u ] );
	NodeBuffer_92959.value[ 1u ] = nodeConst0;
	NodeBuffer_92960.value[ 1u ] = nodeConst0;
	NodeBuffer_92961.value[ 1u ] = nodeConst0;
	NodeBuffer_92962.value[ 1u ] = nodeConst1;
	NodeBuffer_92963.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92968Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92968 : NodeBuffer_92968Struct;

struct NodeBuffer_92969Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92969 : NodeBuffer_92969Struct;

struct NodeBuffer_92970Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92970 : NodeBuffer_92970Struct;

struct NodeBuffer_92971Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92971 : NodeBuffer_92971Struct;

struct NodeBuffer_92972Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92972 : NodeBuffer_92972Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 16u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 17u ] );
	NodeBuffer_92968.value[ 1u ] = nodeConst0;
	NodeBuffer_92969.value[ 1u ] = nodeConst0;
	NodeBuffer_92970.value[ 1u ] = nodeConst0;
	NodeBuffer_92971.value[ 1u ] = nodeConst1;
	NodeBuffer_92972.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92977Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92977 : NodeBuffer_92977Struct;

struct NodeBuffer_92978Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92978 : NodeBuffer_92978Struct;

struct NodeBuffer_92979Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92979 : NodeBuffer_92979Struct;

struct NodeBuffer_92980Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92980 : NodeBuffer_92980Struct;

struct NodeBuffer_92981Struct {
	value : array< u32 >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_92981 : NodeBuffer_92981Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 20u ] );
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 21u ] );
	NodeBuffer_92977.value[ 1u ] = nodeConst0;
	NodeBuffer_92978.value[ 1u ] = nodeConst0;
	NodeBuffer_92979.value[ 1u ] = nodeConst0;
	NodeBuffer_92980.value[ 1u ] = nodeConst1;
	NodeBuffer_92981.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92937Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92937 : NodeBuffer_92937Struct;

struct NodeBuffer_92938Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92938 : NodeBuffer_92938Struct;

struct NodeBuffer_92939Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92939 : NodeBuffer_92939Struct;

struct NodeBuffer_92940Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92940 : NodeBuffer_92940Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 2u ] );
	NodeBuffer_92937.value[ 1u ] = nodeConst0;
	NodeBuffer_92938.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 3u ] );
	NodeBuffer_92939.value[ 1u ] = nodeConst1;
	NodeBuffer_92940.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92946Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92946 : NodeBuffer_92946Struct;

struct NodeBuffer_92947Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92947 : NodeBuffer_92947Struct;

struct NodeBuffer_92948Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92948 : NodeBuffer_92948Struct;

struct NodeBuffer_92949Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92949 : NodeBuffer_92949Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 6u ] );
	NodeBuffer_92946.value[ 1u ] = nodeConst0;
	NodeBuffer_92947.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 7u ] );
	NodeBuffer_92948.value[ 1u ] = nodeConst1;
	NodeBuffer_92949.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92955Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92955 : NodeBuffer_92955Struct;

struct NodeBuffer_92956Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92956 : NodeBuffer_92956Struct;

struct NodeBuffer_92957Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92957 : NodeBuffer_92957Struct;

struct NodeBuffer_92958Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92958 : NodeBuffer_92958Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 10u ] );
	NodeBuffer_92955.value[ 1u ] = nodeConst0;
	NodeBuffer_92956.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 11u ] );
	NodeBuffer_92957.value[ 1u ] = nodeConst1;
	NodeBuffer_92958.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92964Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92964 : NodeBuffer_92964Struct;

struct NodeBuffer_92965Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92965 : NodeBuffer_92965Struct;

struct NodeBuffer_92966Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92966 : NodeBuffer_92966Struct;

struct NodeBuffer_92967Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92967 : NodeBuffer_92967Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 14u ] );
	NodeBuffer_92964.value[ 1u ] = nodeConst0;
	NodeBuffer_92965.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 15u ] );
	NodeBuffer_92966.value[ 1u ] = nodeConst1;
	NodeBuffer_92967.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92973Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92973 : NodeBuffer_92973Struct;

struct NodeBuffer_92974Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92974 : NodeBuffer_92974Struct;

struct NodeBuffer_92975Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92975 : NodeBuffer_92975Struct;

struct NodeBuffer_92976Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92976 : NodeBuffer_92976Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 18u ] );
	NodeBuffer_92973.value[ 1u ] = nodeConst0;
	NodeBuffer_92974.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 19u ] );
	NodeBuffer_92975.value[ 1u ] = nodeConst1;
	NodeBuffer_92976.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92982Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92982 : NodeBuffer_92982Struct;

struct NodeBuffer_92983Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92983 : NodeBuffer_92983Struct;

struct NodeBuffer_92984Struct {
	value : array< u32 >
};
@binding( 3 ) @group( 0 )
var<storage, read_write> NodeBuffer_92984 : NodeBuffer_92984Struct;

struct NodeBuffer_92985Struct {
	value : array< u32 >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_92985 : NodeBuffer_92985Struct;

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

	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 22u ] );
	NodeBuffer_92982.value[ 1u ] = nodeConst0;
	NodeBuffer_92983.value[ 1u ] = nodeConst0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 23u ] );
	NodeBuffer_92984.value[ 1u ] = nodeConst1;
	NodeBuffer_92985.value[ 1u ] = nodeConst1;

	

}

// ---- next kernel ----
// Three.js r184 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_92989Struct {
	value : array< u32 >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_92989 : NodeBuffer_92989Struct;

struct NodeBuffer_92931Struct {
	value : array< atomic<u32> >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_92931 : NodeBuffer_92931Struct;

struct NodeBuffer_92990Struct {
	value : array< u32 >
};
@binding( 2 ) @group( 0 )
var<storage, read_write> NodeBuffer_92990 : NodeBuffer_92990Struct;

struct objectStruct {
	nodeUniform3 : u32
};
@binding( 3 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : u32;

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

	if ( instanceIndex >= object.nodeUniform3 ) { return; }

	nodeVar0 = 0u;
	NodeBuffer_92989.value[ 12u ] = nodeVar0;
	let nodeConst0 = atomicLoad( &NodeBuffer_92931.value[ 2u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst0, 16u ) * NodeBuffer_92989.value[ 1u ] ) );
	NodeBuffer_92989.value[ 13u ] = nodeVar0;
	let nodeConst1 = atomicLoad( &NodeBuffer_92931.value[ 6u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst1, 16u ) * NodeBuffer_92989.value[ 3u ] ) );
	NodeBuffer_92989.value[ 14u ] = nodeVar0;
	let nodeConst2 = atomicLoad( &NodeBuffer_92931.value[ 10u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst2, 16u ) * NodeBuffer_92989.value[ 5u ] ) );
	NodeBuffer_92989.value[ 15u ] = nodeVar0;
	let nodeConst3 = atomicLoad( &NodeBuffer_92931.value[ 14u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst3, 16u ) * NodeBuffer_92989.value[ 7u ] ) );
	NodeBuffer_92989.value[ 16u ] = nodeVar0;
	let nodeConst4 = atomicLoad( &NodeBuffer_92931.value[ 18u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst4, 16u ) * NodeBuffer_92989.value[ 9u ] ) );
	NodeBuffer_92989.value[ 17u ] = nodeVar0;
	let nodeConst5 = atomicLoad( &NodeBuffer_92931.value[ 22u ] );
	nodeVar0 = ( nodeVar0 + ( min( nodeConst5, 16u ) * NodeBuffer_92989.value[ 11u ] ) );
	NodeBuffer_92989.value[ 18u ] = nodeVar0;
	NodeBuffer_92990.value[ 1u ] = ( ( nodeVar0 + 3071u ) / 3072u );

	

}
