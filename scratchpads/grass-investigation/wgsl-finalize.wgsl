// Three.js r184 - Node System

// directives
enable subgroups;

// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct NodeBuffer_1266Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_1266 : NodeBuffer_1266Struct;

struct NodeBuffer_1267Struct {
	value : array< u32 >
};
@binding( 1 ) @group( 0 )
var<storage, read_write> NodeBuffer_1267 : NodeBuffer_1267Struct;

struct objectStruct {
	nodeUniform2 : u32,
	nodeUniform3 : u32,
	nodeUniform4 : u32
};
@binding( 2 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32>,
	@builtin( subgroup_size ) subgroupSize : u32 ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform4 ) { return; }

	let nodeConst0 = atomicLoad( &NodeBuffer_1266.value[ 0u ] );
	NodeBuffer_1267.value[ 1u ] = nodeConst0;

	if ( ( nodeConst0 > object.nodeUniform2 ) ) {

		NodeBuffer_1267.value[ 1u ] = object.nodeUniform2;
		

	}


	if ( ( ( object.nodeUniform3 > 0u ) && ( nodeConst0 > object.nodeUniform3 ) ) ) {

		NodeBuffer_1267.value[ 1u ] = object.nodeUniform3;
		

	}


	

}
