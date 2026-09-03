// Three.js r184 - Node System

// directives
enable subgroups;

// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms
@binding( 1 ) @group( 0 ) var nodeUniform11 : texture_2d<f32>;
@binding( 2 ) @group( 0 ) var nodeUniform15 : texture_2d<f32>;
@binding( 3 ) @group( 0 ) var nodeUniform30 : texture_2d<f32>;
@binding( 6 ) @group( 0 ) var nodeUniform43_sampler : sampler;
@binding( 7 ) @group( 0 ) var nodeUniform43 : texture_2d<f32>;
@binding( 8 ) @group( 0 ) var nodeUniform46_sampler : sampler;
@binding( 9 ) @group( 0 ) var nodeUniform46 : texture_2d<f32>;
@binding( 10 ) @group( 0 ) var nodeUniform47_sampler : sampler;
@binding( 11 ) @group( 0 ) var nodeUniform47 : texture_2d<f32>;
@binding( 12 ) @group( 0 ) var nodeUniform48_sampler : sampler;
@binding( 13 ) @group( 0 ) var nodeUniform48 : texture_2d<f32>;
@binding( 14 ) @group( 0 ) var nodeUniform49_sampler : sampler;
@binding( 15 ) @group( 0 ) var nodeUniform49 : texture_2d<f32>;

struct NodeBuffer_1081Struct {
	value : array< atomic<u32> >
};
@binding( 4 ) @group( 0 )
var<storage, read_write> NodeBuffer_1081 : NodeBuffer_1081Struct;

struct NodeBuffer_1080Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 0 )
var<storage, read_write> NodeBuffer_1080 : NodeBuffer_1080Struct;

struct objectStruct {
	nodeUniform0 : f32,
	nodeUniform1 : f32,
	nodeUniform2 : vec2<f32>,
	nodeUniform3 : f32,
	nodeUniform4 : f32,
	nodeUniform5 : i32,
	nodeUniform6 : i32,
	nodeUniform7 : vec3<f32>,
	nodeUniform8 : f32,
	nodeUniform9 : vec2<f32>,
	nodeUniform10 : f32,
	nodeUniform12 : f32,
	nodeUniform13 : vec2<f32>,
	nodeUniform14 : f32,
	nodeUniform16 : vec2<f32>,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : f32,
	nodeUniform21 : f32,
	nodeUniform22 : f32,
	nodeUniform23 : f32,
	nodeUniform24 : f32,
	nodeUniform25 : f32,
	nodeUniform26 : vec2<f32>,
	nodeUniform27 : f32,
	nodeUniform28 : f32,
	nodeUniform29 : f32,
	nodeUniform32 : u32,
	nodeUniform33 : u32,
	nodeUniform35 : f32,
	nodeUniform36 : f32,
	nodeUniform37 : f32,
	nodeUniform38 : f32,
	nodeUniform39 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : f32,
	nodeUniform42 : f32,
	nodeUniform44 : f32,
	nodeUniform45 : f32,
	nodeUniform50 : f32,
	nodeUniform51 : u32
};
@binding( 0 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : i32;
var<private> nodeVar1 : i32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : i32;
var<private> nodeVar5 : i32;
var<private> nodeVar6 : i32;
var<private> nodeVar7 : i32;
var<private> nodeVar8 : i32;
var<private> nodeVar9 : u32;
var<private> nodeVar10 : i32;
var<private> nodeVar11 : u32;
var<private> nodeVar12 : u32;
var<private> nodeVar13 : f32;
var<private> nodeVar14 : u32;
var<private> nodeVar15 : u32;
var<private> nodeVar16 : u32;
var<private> nodeVar17 : f32;
var<private> nodeVar18 : vec2<f32>;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec2<f32>;
var<private> nodeVar21 : vec2<f32>;
var<private> nodeVar22 : vec2<f32>;
var<private> nodeVar23 : vec4<f32>;
var<private> nodeVar24 : vec2<f32>;
var<private> nodeVar25 : vec4<f32>;
var<private> nodeVar26 : vec2<f32>;
var<private> nodeVar27 : vec4<f32>;
var<private> nodeVar28 : vec4<f32>;
var<private> nodeVar29 : f32;
var<private> nodeVar30 : vec2<f32>;
var<private> nodeVar31 : vec2<f32>;
var<private> nodeVar32 : vec2<f32>;
var<private> nodeVar33 : vec4<f32>;
var<private> nodeVar34 : vec2<f32>;
var<private> nodeVar35 : vec4<f32>;
var<private> nodeVar36 : vec2<f32>;
var<private> nodeVar37 : vec4<f32>;
var<private> nodeVar38 : vec4<f32>;
var<private> nodeVar39 : f32;
var<private> nodeVar40 : f32;
var<private> nodeVar41 : f32;
var<private> nodeVar42 : vec2<f32>;
var<private> nodeVar43 : vec2<f32>;
var<private> nodeVar44 : vec2<f32>;
var<private> nodeVar45 : vec4<f32>;
var<private> nodeVar46 : vec2<f32>;
var<private> nodeVar47 : vec4<f32>;
var<private> nodeVar48 : vec2<f32>;
var<private> nodeVar49 : vec4<f32>;
var<private> nodeVar50 : vec4<f32>;
var<private> nodeVar51 : f32;
var<private> nodeVar52 : f32;
var<private> nodeVar53 : u32;
var<private> nodeVar54 : u32;
var<private> nodeVar55 : u32;
var<private> nodeVar56 : u32;
var<private> nodeVar57 : u32;
var<private> nodeVar58 : u32;
var<private> nodeVar59 : f32;
var<private> nodeVar60 : vec2<f32>;
var<private> nodeVar61 : vec2<f32>;
var<private> nodeVar62 : vec2<f32>;
var<private> nodeVar63 : vec4<f32>;
var<private> nodeVar64 : vec2<f32>;
var<private> nodeVar65 : vec4<f32>;
var<private> nodeVar66 : vec2<f32>;
var<private> nodeVar67 : vec4<f32>;
var<private> nodeVar68 : vec4<f32>;
var<private> nodeVar69 : u32;
var<private> nodeVar70 : u32;
var<private> nodeVar71 : u32;
var<private> nodeVar72 : u32;
var<private> nodeVar73 : u32;
var<private> nodeVar74 : u32;
var<private> nodeVar75 : u32;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : f32;
var<private> nodeVar78 : f32;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : f32;
var<private> nodeVar82 : vec2<f32>;
var<private> nodeVar83 : vec2<f32>;
var<private> nodeVar84 : vec2<f32>;
var<private> nodeVar85 : vec2<f32>;
var<private> nodeVar86 : vec4<f32>;
var<private> nodeVar87 : vec2<f32>;
var<private> nodeVar88 : vec4<f32>;
var<private> nodeVar89 : vec2<f32>;
var<private> nodeVar90 : vec4<f32>;
var<private> nodeVar91 : vec4<f32>;
var<private> nodeVar92 : f32;
var<private> nodeVar93 : vec2<f32>;
var<private> nodeVar94 : vec2<f32>;
var<private> nodeVar95 : vec2<f32>;
var<private> nodeVar96 : vec4<f32>;
var<private> nodeVar97 : vec2<f32>;
var<private> nodeVar98 : vec4<f32>;
var<private> nodeVar99 : vec2<f32>;
var<private> nodeVar100 : vec4<f32>;
var<private> nodeVar101 : vec4<f32>;
var<private> nodeVar102 : f32;
var<private> nodeVar103 : f32;
var<private> nodeVar104 : vec2<f32>;
var<private> nodeVar105 : vec2<f32>;
var<private> nodeVar106 : vec2<f32>;
var<private> nodeVar107 : vec4<f32>;
var<private> nodeVar108 : vec2<f32>;
var<private> nodeVar109 : vec4<f32>;
var<private> nodeVar110 : vec2<f32>;
var<private> nodeVar111 : vec4<f32>;
var<private> nodeVar112 : vec4<f32>;
var<private> nodeVar113 : f32;
var<private> nodeVar114 : vec2<f32>;
var<private> nodeVar115 : vec2<f32>;
var<private> nodeVar116 : vec2<f32>;
var<private> nodeVar117 : vec4<f32>;
var<private> nodeVar118 : vec2<f32>;
var<private> nodeVar119 : vec4<f32>;
var<private> nodeVar120 : vec2<f32>;
var<private> nodeVar121 : vec4<f32>;
var<private> nodeVar122 : vec4<f32>;
var<private> nodeVar123 : f32;
var<private> nodeVar124 : f32;
var<private> nodeVar125 : f32;
var<private> nodeVar126 : f32;
var<private> nodeVar127 : f32;
var<private> nodeVar128 : f32;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : vec4<f32>;
var<private> nodeVar132 : vec2<f32>;
var<private> nodeVar133 : vec4<f32>;
var<private> nodeVar134 : vec4<f32>;
var<private> nodeVar135 : vec4<f32>;
var<private> nodeVar136 : vec4<f32>;
var<private> nodeVar137 : vec4<f32>;
var<private> nodeVar138 : vec3<f32>;

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

	if ( instanceIndex >= object.nodeUniform51 ) { return; }

	nodeVar0 = max( i32( object.nodeUniform0 ), 1 );
	nodeVar1 = ( i32( instanceIndex ) / nodeVar0 );

	if ( ( ( i32( object.nodeUniform0 ) > 0 ) && ( nodeVar1 < ( i32( object.nodeUniform1 ) * i32( object.nodeUniform1 ) ) ) ) ) {

		nodeVar4 = ( nodeVar1 % i32( object.nodeUniform1 ) );
		nodeVar5 = ( ( i32( floor( ( object.nodeUniform2.x / object.nodeUniform3 ) ) ) + nodeVar4 ) - i32( object.nodeUniform4 ) );
		nodeVar6 = ( nodeVar5 + object.nodeUniform5 );
		nodeVar7 = ( ( i32( floor( ( object.nodeUniform2.y / object.nodeUniform3 ) ) ) + ( ( nodeVar1 - nodeVar4 ) / i32( object.nodeUniform1 ) ) ) - i32( object.nodeUniform4 ) );
		nodeVar8 = ( nodeVar7 + object.nodeUniform6 );
		nodeVar9 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
		nodeVar10 = ( i32( instanceIndex ) % nodeVar0 );
		nodeVar11 = ( ( ( ( nodeVar9 ^ ( nodeVar9 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 1 ) * 2246822519u ) );
		nodeVar12 = ( ( nodeVar11 ^ ( nodeVar11 >> 13u ) ) * 3266489917u );
		nodeVar13 = ( ( f32( nodeVar5 ) * object.nodeUniform3 ) + ( ( f32( ( nodeVar12 ^ ( nodeVar12 >> 16u ) ) ) / 4294967296.0 ) * object.nodeUniform3 ) );
		nodeVar14 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
		nodeVar15 = ( ( ( ( nodeVar14 ^ ( nodeVar14 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 2 ) * 2246822519u ) );
		nodeVar16 = ( ( nodeVar15 ^ ( nodeVar15 >> 13u ) ) * 3266489917u );
		nodeVar17 = ( ( f32( nodeVar7 ) * object.nodeUniform3 ) + ( ( f32( ( nodeVar16 ^ ( nodeVar16 >> 16u ) ) ) / 4294967296.0 ) * object.nodeUniform3 ) );
		nodeVar18 = vec2<f32>( object.nodeUniform7.x, object.nodeUniform7.z );
		nodeVar19 = ( vec2<f32>( nodeVar13, nodeVar17 ) + nodeVar18 );
		nodeVar20 = ( ( nodeVar19 / vec2<f32>( object.nodeUniform8 ) ) - object.nodeUniform9 );
		nodeVar21 = floor( nodeVar20 );

		if ( ( ( ( ( nodeVar21.x >= 0.0 ) && ( nodeVar21.y >= 0.0 ) ) && ( nodeVar21.x < ( object.nodeUniform10 - 1.0 ) ) ) && ( nodeVar21.y < ( object.nodeUniform10 - 1.0 ) ) ) ) {

			nodeVar22 = ( nodeVar21 + object.nodeUniform9 );
			nodeVar23 = textureLoad( nodeUniform11, vec2<i32>( vec2<i32>( ( nodeVar22 - ( floor( ( nodeVar22 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).x, vec2<i32>( ( nodeVar22 - ( floor( ( nodeVar22 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).y ), u32( 0u ) );
			nodeVar24 = ( nodeVar22 + vec2<f32>( 1.0 ) );
			nodeVar25 = textureLoad( nodeUniform11, vec2<i32>( vec2<i32>( ( nodeVar24 - ( floor( ( nodeVar24 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).x, vec2<i32>( ( nodeVar22 - ( floor( ( nodeVar22 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).y ), u32( 0u ) );
			nodeVar26 = fract( nodeVar20 );
			nodeVar27 = textureLoad( nodeUniform11, vec2<i32>( vec2<i32>( ( nodeVar22 - ( floor( ( nodeVar22 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).x, vec2<i32>( ( nodeVar24 - ( floor( ( nodeVar24 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).y ), u32( 0u ) );
			nodeVar28 = textureLoad( nodeUniform11, vec2<i32>( vec2<i32>( ( nodeVar24 - ( floor( ( nodeVar24 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).x, vec2<i32>( ( nodeVar24 - ( floor( ( nodeVar24 / vec2<f32>( object.nodeUniform10 ) ) ) * vec2<f32>( object.nodeUniform10 ) ) ) ).y ), u32( 0u ) );
			nodeVar3 = mix( mix( nodeVar23.x, nodeVar25.x, nodeVar26.x ), mix( nodeVar27.x, nodeVar28.x, nodeVar26.x ), nodeVar26.y );

		} else {

			nodeVar3 = -1000000.0;

		}


		if ( ( nodeVar3 > -500000.0 ) ) {

			nodeVar30 = ( ( nodeVar19 / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
			nodeVar31 = floor( nodeVar30 );

			if ( ( ( ( ( nodeVar31.x >= 0.0 ) && ( nodeVar31.y >= 0.0 ) ) && ( nodeVar31.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar31.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

				nodeVar32 = ( nodeVar31 + object.nodeUniform13 );
				nodeVar33 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar32 - ( floor( ( nodeVar32 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar32 - ( floor( ( nodeVar32 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar34 = ( nodeVar32 + vec2<f32>( 1.0 ) );
				nodeVar35 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar34 - ( floor( ( nodeVar34 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar32 - ( floor( ( nodeVar32 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar36 = fract( nodeVar30 );
				nodeVar37 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar32 - ( floor( ( nodeVar32 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar34 - ( floor( ( nodeVar34 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar38 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar34 - ( floor( ( nodeVar34 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar34 - ( floor( ( nodeVar34 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar29 = mix( mix( nodeVar33.x, nodeVar35.x, nodeVar36.x ), mix( nodeVar37.x, nodeVar38.x, nodeVar36.x ), nodeVar36.y );

			} else {

				nodeVar29 = -1000000.0;

			}


			if ( ( nodeVar29 > -500000.0 ) ) {

				nodeVar39 = clamp( ( ( length( ( vec2<f32>( nodeVar13, nodeVar17 ) - object.nodeUniform16 ) ) - object.nodeUniform17 ) / object.nodeUniform18 ), 0.0, 1.0 );

			} else {

				nodeVar39 = 0.0;

			}

			nodeVar2 = mix( nodeVar3, nodeVar29, nodeVar39 );

		} else {

			nodeVar42 = ( ( nodeVar19 / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
			nodeVar43 = floor( nodeVar42 );

			if ( ( ( ( ( nodeVar43.x >= 0.0 ) && ( nodeVar43.y >= 0.0 ) ) && ( nodeVar43.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar43.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

				nodeVar44 = ( nodeVar43 + object.nodeUniform13 );
				nodeVar45 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar44 - ( floor( ( nodeVar44 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar44 - ( floor( ( nodeVar44 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar46 = ( nodeVar44 + vec2<f32>( 1.0 ) );
				nodeVar47 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar46 - ( floor( ( nodeVar46 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar44 - ( floor( ( nodeVar44 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar48 = fract( nodeVar42 );
				nodeVar49 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar44 - ( floor( ( nodeVar44 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar46 - ( floor( ( nodeVar46 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar50 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar46 - ( floor( ( nodeVar46 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar46 - ( floor( ( nodeVar46 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
				nodeVar41 = mix( mix( nodeVar45.x, nodeVar47.x, nodeVar48.x ), mix( nodeVar49.x, nodeVar50.x, nodeVar48.x ), nodeVar48.y );

			} else {

				nodeVar41 = -1000000.0;

			}


			if ( ( nodeVar41 > -500000.0 ) ) {

				nodeVar40 = nodeVar41;

			} else {

				nodeVar40 = -100000.0;

			}

			nodeVar2 = nodeVar40;

		}

		nodeVar51 = ( nodeVar2 - object.nodeUniform7.y );
		nodeVar52 = length( vec2<f32>( ( nodeVar13 - object.nodeUniform2.x ), ( nodeVar17 - object.nodeUniform2.y ) ) );
		nodeVar53 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
		nodeVar54 = ( ( ( ( nodeVar53 ^ ( nodeVar53 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 7 ) * 2246822519u ) );
		nodeVar55 = ( ( nodeVar54 ^ ( nodeVar54 >> 13u ) ) * 3266489917u );
		nodeVar56 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
		nodeVar57 = ( ( ( ( nodeVar56 ^ ( nodeVar56 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 8 ) * 2246822519u ) );
		nodeVar58 = ( ( nodeVar57 ^ ( nodeVar57 >> 13u ) ) * 3266489917u );
		nodeVar60 = ( ( ( vec2<f32>( nodeVar13, nodeVar17 ) + nodeVar18 ) / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
		nodeVar61 = floor( nodeVar60 );

		if ( ( ( ( ( nodeVar61.x >= 0.0 ) && ( nodeVar61.y >= 0.0 ) ) && ( nodeVar61.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar61.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

			nodeVar62 = ( nodeVar61 + object.nodeUniform13 );
			nodeVar63 = textureLoad( nodeUniform30, vec2<i32>( vec2<i32>( ( nodeVar62 - ( floor( ( nodeVar62 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar62 - ( floor( ( nodeVar62 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
			nodeVar64 = ( nodeVar62 + vec2<f32>( 1.0 ) );
			nodeVar65 = textureLoad( nodeUniform30, vec2<i32>( vec2<i32>( ( nodeVar64 - ( floor( ( nodeVar64 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar62 - ( floor( ( nodeVar62 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
			nodeVar66 = fract( nodeVar60 );
			nodeVar67 = textureLoad( nodeUniform30, vec2<i32>( vec2<i32>( ( nodeVar62 - ( floor( ( nodeVar62 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar64 - ( floor( ( nodeVar64 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
			nodeVar68 = textureLoad( nodeUniform30, vec2<i32>( vec2<i32>( ( nodeVar64 - ( floor( ( nodeVar64 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar64 - ( floor( ( nodeVar64 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
			nodeVar59 = mix( mix( ( nodeVar63.x * 255.0 ), ( nodeVar65.x * 255.0 ), nodeVar66.x ), mix( ( nodeVar67.x * 255.0 ), ( nodeVar68.x * 255.0 ), nodeVar66.x ), nodeVar66.y );

		} else {

			nodeVar59 = 0.0;

		}


		if ( ( ( ( ( ( ( ( ( ( ( nodeVar51 > object.nodeUniform19 ) && ( nodeVar13 >= object.nodeUniform20 ) ) && ( nodeVar13 <= object.nodeUniform21 ) ) && ( nodeVar17 >= object.nodeUniform22 ) ) && ( nodeVar17 <= object.nodeUniform23 ) ) && ( nodeVar52 < object.nodeUniform24 ) ) && ( ( nodeVar52 < object.nodeUniform25 ) || ( dot( ( vec2<f32>( ( nodeVar13 - object.nodeUniform2.x ), ( nodeVar17 - object.nodeUniform2.y ) ) / vec2<f32>( max( nodeVar52, 0.001 ) ) ), object.nodeUniform26 ) > object.nodeUniform27 ) ) ) && ( 1.0 > 0.0 ) ) && ( ( f32( ( nodeVar55 ^ ( nodeVar55 >> 16u ) ) ) / 4294967296.0 ) > clamp( ( ( nodeVar52 - object.nodeUniform28 ) / max( ( object.nodeUniform24 - object.nodeUniform28 ), 0.001 ) ), 0.0, 1.0 ) ) ) && ( ( f32( ( nodeVar58 ^ ( nodeVar58 >> 16u ) ) ) / 4294967296.0 ) < clamp( ( ( 1.0 - object.nodeUniform29 ) + ( clamp( ( nodeVar59 / 255.0 ), 0.0, 1.0 ) * object.nodeUniform29 ) ), 0.0, 1.0 ) ) ) ) {

			let nodeConst0 = atomicAdd( &NodeBuffer_1081.value[ 0u ], 1u );

			if ( ( ( nodeConst0 < object.nodeUniform32 ) && ( ( object.nodeUniform33 == 0u ) || ( nodeConst0 < object.nodeUniform33 ) ) ) ) {

				nodeVar69 = ( nodeConst0 * 2u );
				nodeVar70 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
				nodeVar71 = ( ( ( ( nodeVar70 ^ ( nodeVar70 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 5 ) * 2246822519u ) );
				nodeVar72 = ( ( nodeVar71 ^ ( nodeVar71 >> 13u ) ) * 3266489917u );
				NodeBuffer_1080.value[ nodeVar69 ] = vec4<f32>( nodeVar13, nodeVar51, nodeVar17, ( 0.8 + ( ( f32( ( nodeVar72 ^ ( nodeVar72 >> 16u ) ) ) / 4294967296.0 ) * 0.6 ) ) );
				nodeVar73 = ( ( bitcast<u32>( nodeVar6 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar8 ) * 3812015801u ) );
				nodeVar74 = ( ( ( ( nodeVar73 ^ ( nodeVar73 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar10 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 3 ) * 2246822519u ) );
				nodeVar75 = ( ( nodeVar74 ^ ( nodeVar74 >> 13u ) ) * 3266489917u );
				nodeVar77 = ( nodeVar51 + object.nodeUniform7.y );
				nodeVar78 = ( nodeVar77 - object.nodeUniform35 );

				if ( ( nodeVar78 < 0.0 ) ) {

					nodeVar76 = mix( vec3<f32>( 0.16, 0.32, 0.42 ), vec3<f32>( 0.72, 0.66, 0.46 ), clamp( ( 1.0 + ( nodeVar78 / 6.0 ) ), 0.0, 1.0 ) );

				} else {


					if ( ( nodeVar78 < 2.0 ) ) {

						nodeVar79 = mix( vec3<f32>( 0.72, 0.66, 0.46 ), vec3<f32>( 0.3, 0.48, 0.22 ), clamp( ( nodeVar78 / 2.0 ), 0.0, 1.0 ) );

					} else {


						if ( ( nodeVar78 < 60.0 ) ) {

							nodeVar80 = mix( vec3<f32>( 0.3, 0.48, 0.22 ), vec3<f32>( 0.46, 0.44, 0.28 ), clamp( ( ( nodeVar78 - 20.0 ) / 40.0 ), 0.0, 1.0 ) );

						} else {

							nodeVar80 = mix( vec3<f32>( 0.46, 0.44, 0.28 ), vec3<f32>( 0.92, 0.93, 0.95 ), clamp( ( ( nodeVar78 - 60.0 ) / 40.0 ), 0.0, 1.0 ) );

						}

						nodeVar79 = nodeVar80;

					}

					nodeVar76 = nodeVar79;

				}

				nodeVar82 = ( vec2<f32>( nodeVar13, nodeVar17 ) + nodeVar18 );
				nodeVar83 = ( ( vec2<f32>( ( nodeVar82.x + 8.0 ), nodeVar82.y ) / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
				nodeVar84 = floor( nodeVar83 );

				if ( ( ( ( ( nodeVar84.x >= 0.0 ) && ( nodeVar84.y >= 0.0 ) ) && ( nodeVar84.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar84.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

					nodeVar85 = ( nodeVar84 + object.nodeUniform13 );
					nodeVar86 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar85 - ( floor( ( nodeVar85 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar85 - ( floor( ( nodeVar85 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar87 = ( nodeVar85 + vec2<f32>( 1.0 ) );
					nodeVar88 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar87 - ( floor( ( nodeVar87 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar85 - ( floor( ( nodeVar85 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar89 = fract( nodeVar83 );
					nodeVar90 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar85 - ( floor( ( nodeVar85 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar87 - ( floor( ( nodeVar87 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar91 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar87 - ( floor( ( nodeVar87 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar87 - ( floor( ( nodeVar87 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar81 = mix( mix( nodeVar86.x, nodeVar88.x, nodeVar89.x ), mix( nodeVar90.x, nodeVar91.x, nodeVar89.x ), nodeVar89.y );

				} else {

					nodeVar81 = nodeVar77;

				}

				nodeVar93 = ( ( vec2<f32>( ( nodeVar82.x - 8.0 ), nodeVar82.y ) / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
				nodeVar94 = floor( nodeVar93 );

				if ( ( ( ( ( nodeVar94.x >= 0.0 ) && ( nodeVar94.y >= 0.0 ) ) && ( nodeVar94.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar94.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

					nodeVar95 = ( nodeVar94 + object.nodeUniform13 );
					nodeVar96 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar95 - ( floor( ( nodeVar95 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar95 - ( floor( ( nodeVar95 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar97 = ( nodeVar95 + vec2<f32>( 1.0 ) );
					nodeVar98 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar95 - ( floor( ( nodeVar95 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar99 = fract( nodeVar93 );
					nodeVar100 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar95 - ( floor( ( nodeVar95 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar101 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar92 = mix( mix( nodeVar96.x, nodeVar98.x, nodeVar99.x ), mix( nodeVar100.x, nodeVar101.x, nodeVar99.x ), nodeVar99.y );

				} else {

					nodeVar92 = nodeVar77;

				}

				nodeVar102 = ( ( nodeVar81 - nodeVar92 ) / ( 8.0 * 2.0 ) );
				nodeVar104 = ( ( vec2<f32>( nodeVar82.x, ( nodeVar82.y + 8.0 ) ) / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
				nodeVar105 = floor( nodeVar104 );

				if ( ( ( ( ( nodeVar105.x >= 0.0 ) && ( nodeVar105.y >= 0.0 ) ) && ( nodeVar105.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar105.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

					nodeVar106 = ( nodeVar105 + object.nodeUniform13 );
					nodeVar107 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar108 = ( nodeVar106 + vec2<f32>( 1.0 ) );
					nodeVar109 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar108 - ( floor( ( nodeVar108 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar110 = fract( nodeVar104 );
					nodeVar111 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar108 - ( floor( ( nodeVar108 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar112 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar108 - ( floor( ( nodeVar108 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar108 - ( floor( ( nodeVar108 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar103 = mix( mix( nodeVar107.x, nodeVar109.x, nodeVar110.x ), mix( nodeVar111.x, nodeVar112.x, nodeVar110.x ), nodeVar110.y );

				} else {

					nodeVar103 = nodeVar77;

				}

				nodeVar114 = ( ( vec2<f32>( nodeVar82.x, ( nodeVar82.y - 8.0 ) ) / vec2<f32>( object.nodeUniform12 ) ) - object.nodeUniform13 );
				nodeVar115 = floor( nodeVar114 );

				if ( ( ( ( ( nodeVar115.x >= 0.0 ) && ( nodeVar115.y >= 0.0 ) ) && ( nodeVar115.x < ( object.nodeUniform14 - 1.0 ) ) ) && ( nodeVar115.y < ( object.nodeUniform14 - 1.0 ) ) ) ) {

					nodeVar116 = ( nodeVar115 + object.nodeUniform13 );
					nodeVar117 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar118 = ( nodeVar116 + vec2<f32>( 1.0 ) );
					nodeVar119 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar118 - ( floor( ( nodeVar118 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar120 = fract( nodeVar114 );
					nodeVar121 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar118 - ( floor( ( nodeVar118 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar122 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar118 - ( floor( ( nodeVar118 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).x, vec2<i32>( ( nodeVar118 - ( floor( ( nodeVar118 / vec2<f32>( object.nodeUniform14 ) ) ) * vec2<f32>( object.nodeUniform14 ) ) ) ).y ), u32( 0u ) );
					nodeVar113 = mix( mix( nodeVar117.x, nodeVar119.x, nodeVar120.x ), mix( nodeVar121.x, nodeVar122.x, nodeVar120.x ), nodeVar120.y );

				} else {

					nodeVar113 = nodeVar77;

				}

				nodeVar123 = ( ( nodeVar103 - nodeVar113 ) / ( 8.0 * 2.0 ) );
				nodeVar124 = ( 1.0 / sqrt( ( ( ( nodeVar102 * nodeVar102 ) + ( nodeVar123 * nodeVar123 ) ) + 1.0 ) ) );
				nodeVar125 = ( 1.0 - smoothstep( ( object.nodeUniform36 - 1.5 ), ( object.nodeUniform36 + 1.5 ), nodeVar77 ) );
				nodeVar126 = ( 1.0 - smoothstep( object.nodeUniform37, object.nodeUniform38, nodeVar124 ) );
				nodeVar127 = ( 1.0 - nodeVar126 );
				nodeVar128 = ( 1.0 - nodeVar125 );
				nodeVar129 = smoothstep( object.nodeUniform39, object.nodeUniform40, nodeVar77 );
				nodeVar130 = smoothstep( object.nodeUniform41, object.nodeUniform42, nodeVar77 );
				nodeVar131 = vec4<f32>( ( nodeVar125 * nodeVar127 ), ( ( ( nodeVar128 * ( 1.0 - nodeVar129 ) ) * ( 1.0 - nodeVar130 ) ) * nodeVar127 ), ( ( ( nodeVar128 * nodeVar129 ) * ( 1.0 - nodeVar130 ) ) * nodeVar127 ), nodeVar126 );
				nodeVar132 = ( vec2<f32>( nodeVar82.x, nodeVar82.y ) * vec2<f32>( object.nodeUniform44 ) );
				nodeVar133 = textureSampleLevel( nodeUniform43, nodeUniform43_sampler, nodeVar132, object.nodeUniform45 );
				nodeVar134 = textureSampleLevel( nodeUniform46, nodeUniform46_sampler, nodeVar132, object.nodeUniform45 );
				nodeVar135 = textureSampleLevel( nodeUniform47, nodeUniform47_sampler, nodeVar132, object.nodeUniform45 );
				nodeVar136 = textureSampleLevel( nodeUniform48, nodeUniform48_sampler, nodeVar132, object.nodeUniform45 );
				nodeVar137 = textureSampleLevel( nodeUniform49, nodeUniform49_sampler, nodeVar132, object.nodeUniform45 );
				nodeVar138 = mix( mix( nodeVar76, vec3<f32>( 0.42, 0.4, 0.38 ), clamp( ( ( 0.82 - nodeVar124 ) / 0.25 ), 0.0, 1.0 ) ), ( ( ( ( ( nodeVar133.xyz * vec3<f32>( nodeVar131.x ) ) + ( nodeVar134.xyz * vec3<f32>( nodeVar131.y ) ) ) + ( nodeVar135.xyz * vec3<f32>( nodeVar131.z ) ) ) + ( nodeVar136.xyz * vec3<f32>( nodeVar131.w ) ) ) + ( nodeVar137.xyz * vec3<f32>( max( ( 1.0 - ( ( ( nodeVar131.x + nodeVar131.y ) + nodeVar131.z ) + nodeVar131.w ) ), 0.0 ) ) ) ), object.nodeUniform50 );
				NodeBuffer_1080.value[ ( nodeVar69 + 1u ) ] = vec4<f32>( ( ( f32( ( nodeVar75 ^ ( nodeVar75 >> 16u ) ) ) / 4294967296.0 ) * 6.2831853 ), nodeVar138.x, nodeVar138.y, nodeVar138.z );
				

			}

			

		}

		

	}


	

}
