// Three.js r184 - Node System

// directives
enable subgroups;

// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms
@binding( 2 ) @group( 0 ) var nodeUniform6 : texture_2d<f32>;
@binding( 3 ) @group( 0 ) var nodeUniform10 : texture_2d<f32>;
@binding( 4 ) @group( 0 ) var nodeUniform22_sampler : sampler;
@binding( 5 ) @group( 0 ) var nodeUniform22 : texture_2d<f32>;
@binding( 6 ) @group( 0 ) var nodeUniform25_sampler : sampler;
@binding( 7 ) @group( 0 ) var nodeUniform25 : texture_2d<f32>;
@binding( 8 ) @group( 0 ) var nodeUniform26_sampler : sampler;
@binding( 9 ) @group( 0 ) var nodeUniform26 : texture_2d<f32>;
@binding( 10 ) @group( 0 ) var nodeUniform27_sampler : sampler;
@binding( 11 ) @group( 0 ) var nodeUniform27 : texture_2d<f32>;
@binding( 12 ) @group( 0 ) var nodeUniform28_sampler : sampler;
@binding( 13 ) @group( 0 ) var nodeUniform28 : texture_2d<f32>;

struct NodeBuffer_1133Struct {
	value : array< vec4<f32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_1133 : NodeBuffer_1133Struct;

struct objectStruct {
	nodeUniform1 : vec2<f32>,
	nodeUniform2 : vec3<f32>,
	nodeUniform3 : f32,
	nodeUniform4 : vec2<f32>,
	nodeUniform5 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : vec2<f32>,
	nodeUniform9 : f32,
	nodeUniform11 : vec2<f32>,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : f32,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : f32,
	nodeUniform21 : f32,
	nodeUniform23 : f32,
	nodeUniform24 : f32,
	nodeUniform29 : f32,
	nodeUniform30 : u32
};
@binding( 1 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : vec3<f32>;
var<private> nodeVar1 : f32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : vec2<f32>;
var<private> nodeVar4 : vec2<f32>;
var<private> nodeVar5 : vec2<f32>;
var<private> nodeVar6 : vec2<f32>;
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : vec4<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec4<f32>;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : vec4<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : f32;
var<private> nodeVar15 : vec2<f32>;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec4<f32>;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec2<f32>;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec4<f32>;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec2<f32>;
var<private> nodeVar28 : vec2<f32>;
var<private> nodeVar29 : vec2<f32>;
var<private> nodeVar30 : vec4<f32>;
var<private> nodeVar31 : vec2<f32>;
var<private> nodeVar32 : vec4<f32>;
var<private> nodeVar33 : vec2<f32>;
var<private> nodeVar34 : vec4<f32>;
var<private> nodeVar35 : vec4<f32>;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : f32;
var<private> nodeVar39 : vec3<f32>;
var<private> nodeVar40 : vec3<f32>;
var<private> nodeVar41 : f32;
var<private> nodeVar42 : vec2<f32>;
var<private> nodeVar43 : vec2<f32>;
var<private> nodeVar44 : vec2<f32>;
var<private> nodeVar45 : vec2<f32>;
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec2<f32>;
var<private> nodeVar48 : vec4<f32>;
var<private> nodeVar49 : vec2<f32>;
var<private> nodeVar50 : vec4<f32>;
var<private> nodeVar51 : vec4<f32>;
var<private> nodeVar52 : f32;
var<private> nodeVar53 : vec2<f32>;
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : vec2<f32>;
var<private> nodeVar56 : vec4<f32>;
var<private> nodeVar57 : vec2<f32>;
var<private> nodeVar58 : vec4<f32>;
var<private> nodeVar59 : vec2<f32>;
var<private> nodeVar60 : vec4<f32>;
var<private> nodeVar61 : vec4<f32>;
var<private> nodeVar62 : f32;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : vec2<f32>;
var<private> nodeVar65 : vec2<f32>;
var<private> nodeVar66 : vec2<f32>;
var<private> nodeVar67 : vec4<f32>;
var<private> nodeVar68 : vec2<f32>;
var<private> nodeVar69 : vec4<f32>;
var<private> nodeVar70 : vec2<f32>;
var<private> nodeVar71 : vec4<f32>;
var<private> nodeVar72 : vec4<f32>;
var<private> nodeVar73 : f32;
var<private> nodeVar74 : vec2<f32>;
var<private> nodeVar75 : vec2<f32>;
var<private> nodeVar76 : vec2<f32>;
var<private> nodeVar77 : vec4<f32>;
var<private> nodeVar78 : vec2<f32>;
var<private> nodeVar79 : vec4<f32>;
var<private> nodeVar80 : vec2<f32>;
var<private> nodeVar81 : vec4<f32>;
var<private> nodeVar82 : vec4<f32>;
var<private> nodeVar83 : f32;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : f32;
var<private> nodeVar87 : f32;
var<private> nodeVar88 : f32;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : f32;
var<private> nodeVar91 : vec4<f32>;
var<private> nodeVar92 : vec2<f32>;
var<private> nodeVar93 : vec4<f32>;
var<private> nodeVar94 : vec4<f32>;
var<private> nodeVar95 : vec4<f32>;
var<private> nodeVar96 : vec4<f32>;
var<private> nodeVar97 : vec4<f32>;
var<private> nodeVar98 : vec3<f32>;

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

	if ( instanceIndex >= object.nodeUniform30 ) { return; }

	nodeVar3 = vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.z );
	nodeVar4 = ( vec2<f32>( object.nodeUniform1.x, object.nodeUniform1.y ) + nodeVar3 );
	nodeVar5 = ( ( nodeVar4 / vec2<f32>( object.nodeUniform3 ) ) - object.nodeUniform4 );
	nodeVar6 = floor( nodeVar5 );

	if ( ( ( ( ( nodeVar6.x >= 0.0 ) && ( nodeVar6.y >= 0.0 ) ) && ( nodeVar6.x < ( object.nodeUniform5 - 1.0 ) ) ) && ( nodeVar6.y < ( object.nodeUniform5 - 1.0 ) ) ) ) {

		nodeVar7 = ( nodeVar6 + object.nodeUniform4 );
		nodeVar8 = textureLoad( nodeUniform6, vec2<i32>( vec2<i32>( ( nodeVar7 - ( floor( ( nodeVar7 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).x, vec2<i32>( ( nodeVar7 - ( floor( ( nodeVar7 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).y ), u32( 0u ) );
		nodeVar9 = ( nodeVar7 + vec2<f32>( 1.0 ) );
		nodeVar10 = textureLoad( nodeUniform6, vec2<i32>( vec2<i32>( ( nodeVar9 - ( floor( ( nodeVar9 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).x, vec2<i32>( ( nodeVar7 - ( floor( ( nodeVar7 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).y ), u32( 0u ) );
		nodeVar11 = fract( nodeVar5 );
		nodeVar12 = textureLoad( nodeUniform6, vec2<i32>( vec2<i32>( ( nodeVar7 - ( floor( ( nodeVar7 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).x, vec2<i32>( ( nodeVar9 - ( floor( ( nodeVar9 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).y ), u32( 0u ) );
		nodeVar13 = textureLoad( nodeUniform6, vec2<i32>( vec2<i32>( ( nodeVar9 - ( floor( ( nodeVar9 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).x, vec2<i32>( ( nodeVar9 - ( floor( ( nodeVar9 / vec2<f32>( object.nodeUniform5 ) ) ) * vec2<f32>( object.nodeUniform5 ) ) ) ).y ), u32( 0u ) );
		nodeVar2 = mix( mix( nodeVar8.x, nodeVar10.x, nodeVar11.x ), mix( nodeVar12.x, nodeVar13.x, nodeVar11.x ), nodeVar11.y );

	} else {

		nodeVar2 = -1000000.0;

	}


	if ( ( nodeVar2 > -500000.0 ) ) {

		nodeVar15 = ( ( nodeVar4 / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
		nodeVar16 = floor( nodeVar15 );

		if ( ( ( ( ( nodeVar16.x >= 0.0 ) && ( nodeVar16.y >= 0.0 ) ) && ( nodeVar16.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar16.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

			nodeVar17 = ( nodeVar16 + object.nodeUniform8 );
			nodeVar18 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar17 - ( floor( ( nodeVar17 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar17 - ( floor( ( nodeVar17 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar19 = ( nodeVar17 + vec2<f32>( 1.0 ) );
			nodeVar20 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar19 - ( floor( ( nodeVar19 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar17 - ( floor( ( nodeVar17 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar21 = fract( nodeVar15 );
			nodeVar22 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar17 - ( floor( ( nodeVar17 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar19 - ( floor( ( nodeVar19 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar23 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar19 - ( floor( ( nodeVar19 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar19 - ( floor( ( nodeVar19 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar14 = mix( mix( nodeVar18.x, nodeVar20.x, nodeVar21.x ), mix( nodeVar22.x, nodeVar23.x, nodeVar21.x ), nodeVar21.y );

		} else {

			nodeVar14 = -1000000.0;

		}


		if ( ( nodeVar14 > -500000.0 ) ) {

			nodeVar24 = clamp( ( ( length( ( vec2<f32>( object.nodeUniform1.x, object.nodeUniform1.y ) - object.nodeUniform11 ) ) - object.nodeUniform12 ) / object.nodeUniform13 ), 0.0, 1.0 );

		} else {

			nodeVar24 = 0.0;

		}

		nodeVar1 = mix( nodeVar2, nodeVar14, nodeVar24 );

	} else {

		nodeVar27 = ( ( nodeVar4 / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
		nodeVar28 = floor( nodeVar27 );

		if ( ( ( ( ( nodeVar28.x >= 0.0 ) && ( nodeVar28.y >= 0.0 ) ) && ( nodeVar28.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar28.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

			nodeVar29 = ( nodeVar28 + object.nodeUniform8 );
			nodeVar30 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar29 - ( floor( ( nodeVar29 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar29 - ( floor( ( nodeVar29 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar31 = ( nodeVar29 + vec2<f32>( 1.0 ) );
			nodeVar32 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar31 - ( floor( ( nodeVar31 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar29 - ( floor( ( nodeVar29 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar33 = fract( nodeVar27 );
			nodeVar34 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar29 - ( floor( ( nodeVar29 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar31 - ( floor( ( nodeVar31 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar35 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar31 - ( floor( ( nodeVar31 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar31 - ( floor( ( nodeVar31 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
			nodeVar26 = mix( mix( nodeVar30.x, nodeVar32.x, nodeVar33.x ), mix( nodeVar34.x, nodeVar35.x, nodeVar33.x ), nodeVar33.y );

		} else {

			nodeVar26 = -1000000.0;

		}


		if ( ( nodeVar26 > -500000.0 ) ) {

			nodeVar25 = nodeVar26;

		} else {

			nodeVar25 = -100000.0;

		}

		nodeVar1 = nodeVar25;

	}

	nodeVar36 = ( nodeVar1 - object.nodeUniform2.y );
	nodeVar37 = ( nodeVar36 + object.nodeUniform2.y );
	nodeVar38 = ( nodeVar37 - object.nodeUniform14 );

	if ( ( nodeVar38 < 0.0 ) ) {

		nodeVar0 = mix( vec3<f32>( 0.16, 0.32, 0.42 ), vec3<f32>( 0.72, 0.66, 0.46 ), clamp( ( 1.0 + ( nodeVar38 / 6.0 ) ), 0.0, 1.0 ) );

	} else {


		if ( ( nodeVar38 < 2.0 ) ) {

			nodeVar39 = mix( vec3<f32>( 0.72, 0.66, 0.46 ), vec3<f32>( 0.3, 0.48, 0.22 ), clamp( ( nodeVar38 / 2.0 ), 0.0, 1.0 ) );

		} else {


			if ( ( nodeVar38 < 60.0 ) ) {

				nodeVar40 = mix( vec3<f32>( 0.3, 0.48, 0.22 ), vec3<f32>( 0.46, 0.44, 0.28 ), clamp( ( ( nodeVar38 - 20.0 ) / 40.0 ), 0.0, 1.0 ) );

			} else {

				nodeVar40 = mix( vec3<f32>( 0.46, 0.44, 0.28 ), vec3<f32>( 0.92, 0.93, 0.95 ), clamp( ( ( nodeVar38 - 60.0 ) / 40.0 ), 0.0, 1.0 ) );

			}

			nodeVar39 = nodeVar40;

		}

		nodeVar0 = nodeVar39;

	}

	nodeVar42 = ( vec2<f32>( object.nodeUniform1.x, object.nodeUniform1.y ) + nodeVar3 );
	nodeVar43 = ( ( vec2<f32>( ( nodeVar42.x + 8.0 ), nodeVar42.y ) / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
	nodeVar44 = floor( nodeVar43 );

	if ( ( ( ( ( nodeVar44.x >= 0.0 ) && ( nodeVar44.y >= 0.0 ) ) && ( nodeVar44.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar44.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

		nodeVar45 = ( nodeVar44 + object.nodeUniform8 );
		nodeVar46 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar47 = ( nodeVar45 + vec2<f32>( 1.0 ) );
		nodeVar48 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar49 = fract( nodeVar43 );
		nodeVar50 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar51 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar41 = mix( mix( nodeVar46.x, nodeVar48.x, nodeVar49.x ), mix( nodeVar50.x, nodeVar51.x, nodeVar49.x ), nodeVar49.y );

	} else {

		nodeVar41 = nodeVar37;

	}

	nodeVar53 = ( ( vec2<f32>( ( nodeVar42.x - 8.0 ), nodeVar42.y ) / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
	nodeVar54 = floor( nodeVar53 );

	if ( ( ( ( ( nodeVar54.x >= 0.0 ) && ( nodeVar54.y >= 0.0 ) ) && ( nodeVar54.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar54.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

		nodeVar55 = ( nodeVar54 + object.nodeUniform8 );
		nodeVar56 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar57 = ( nodeVar55 + vec2<f32>( 1.0 ) );
		nodeVar58 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar57 - ( floor( ( nodeVar57 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar59 = fract( nodeVar53 );
		nodeVar60 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar57 - ( floor( ( nodeVar57 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar61 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar57 - ( floor( ( nodeVar57 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar57 - ( floor( ( nodeVar57 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar52 = mix( mix( nodeVar56.x, nodeVar58.x, nodeVar59.x ), mix( nodeVar60.x, nodeVar61.x, nodeVar59.x ), nodeVar59.y );

	} else {

		nodeVar52 = nodeVar37;

	}

	nodeVar62 = ( ( nodeVar41 - nodeVar52 ) / ( 8.0 * 2.0 ) );
	nodeVar64 = ( ( vec2<f32>( nodeVar42.x, ( nodeVar42.y + 8.0 ) ) / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
	nodeVar65 = floor( nodeVar64 );

	if ( ( ( ( ( nodeVar65.x >= 0.0 ) && ( nodeVar65.y >= 0.0 ) ) && ( nodeVar65.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar65.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

		nodeVar66 = ( nodeVar65 + object.nodeUniform8 );
		nodeVar67 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar66 - ( floor( ( nodeVar66 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar66 - ( floor( ( nodeVar66 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar68 = ( nodeVar66 + vec2<f32>( 1.0 ) );
		nodeVar69 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar68 - ( floor( ( nodeVar68 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar66 - ( floor( ( nodeVar66 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar70 = fract( nodeVar64 );
		nodeVar71 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar66 - ( floor( ( nodeVar66 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar68 - ( floor( ( nodeVar68 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar72 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar68 - ( floor( ( nodeVar68 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar68 - ( floor( ( nodeVar68 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar63 = mix( mix( nodeVar67.x, nodeVar69.x, nodeVar70.x ), mix( nodeVar71.x, nodeVar72.x, nodeVar70.x ), nodeVar70.y );

	} else {

		nodeVar63 = nodeVar37;

	}

	nodeVar74 = ( ( vec2<f32>( nodeVar42.x, ( nodeVar42.y - 8.0 ) ) / vec2<f32>( object.nodeUniform7 ) ) - object.nodeUniform8 );
	nodeVar75 = floor( nodeVar74 );

	if ( ( ( ( ( nodeVar75.x >= 0.0 ) && ( nodeVar75.y >= 0.0 ) ) && ( nodeVar75.x < ( object.nodeUniform9 - 1.0 ) ) ) && ( nodeVar75.y < ( object.nodeUniform9 - 1.0 ) ) ) ) {

		nodeVar76 = ( nodeVar75 + object.nodeUniform8 );
		nodeVar77 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar76 - ( floor( ( nodeVar76 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar76 - ( floor( ( nodeVar76 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar78 = ( nodeVar76 + vec2<f32>( 1.0 ) );
		nodeVar79 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar78 - ( floor( ( nodeVar78 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar76 - ( floor( ( nodeVar76 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar80 = fract( nodeVar74 );
		nodeVar81 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar76 - ( floor( ( nodeVar76 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar78 - ( floor( ( nodeVar78 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar82 = textureLoad( nodeUniform10, vec2<i32>( vec2<i32>( ( nodeVar78 - ( floor( ( nodeVar78 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).x, vec2<i32>( ( nodeVar78 - ( floor( ( nodeVar78 / vec2<f32>( object.nodeUniform9 ) ) ) * vec2<f32>( object.nodeUniform9 ) ) ) ).y ), u32( 0u ) );
		nodeVar73 = mix( mix( nodeVar77.x, nodeVar79.x, nodeVar80.x ), mix( nodeVar81.x, nodeVar82.x, nodeVar80.x ), nodeVar80.y );

	} else {

		nodeVar73 = nodeVar37;

	}

	nodeVar83 = ( ( nodeVar63 - nodeVar73 ) / ( 8.0 * 2.0 ) );
	nodeVar84 = ( 1.0 / sqrt( ( ( ( nodeVar62 * nodeVar62 ) + ( nodeVar83 * nodeVar83 ) ) + 1.0 ) ) );
	nodeVar85 = ( 1.0 - smoothstep( ( object.nodeUniform15 - 1.5 ), ( object.nodeUniform15 + 1.5 ), nodeVar37 ) );
	nodeVar86 = ( 1.0 - smoothstep( object.nodeUniform16, object.nodeUniform17, nodeVar84 ) );
	nodeVar87 = ( 1.0 - nodeVar86 );
	nodeVar88 = ( 1.0 - nodeVar85 );
	nodeVar89 = smoothstep( object.nodeUniform18, object.nodeUniform19, nodeVar37 );
	nodeVar90 = smoothstep( object.nodeUniform20, object.nodeUniform21, nodeVar37 );
	nodeVar91 = vec4<f32>( ( nodeVar85 * nodeVar87 ), ( ( ( nodeVar88 * ( 1.0 - nodeVar89 ) ) * ( 1.0 - nodeVar90 ) ) * nodeVar87 ), ( ( ( nodeVar88 * nodeVar89 ) * ( 1.0 - nodeVar90 ) ) * nodeVar87 ), nodeVar86 );
	nodeVar92 = ( vec2<f32>( nodeVar42.x, nodeVar42.y ) * vec2<f32>( object.nodeUniform23 ) );
	nodeVar93 = textureSampleLevel( nodeUniform22, nodeUniform22_sampler, nodeVar92, object.nodeUniform24 );
	nodeVar94 = textureSampleLevel( nodeUniform25, nodeUniform25_sampler, nodeVar92, object.nodeUniform24 );
	nodeVar95 = textureSampleLevel( nodeUniform26, nodeUniform26_sampler, nodeVar92, object.nodeUniform24 );
	nodeVar96 = textureSampleLevel( nodeUniform27, nodeUniform27_sampler, nodeVar92, object.nodeUniform24 );
	nodeVar97 = textureSampleLevel( nodeUniform28, nodeUniform28_sampler, nodeVar92, object.nodeUniform24 );
	nodeVar98 = mix( mix( nodeVar0, vec3<f32>( 0.42, 0.4, 0.38 ), clamp( ( ( 0.82 - nodeVar84 ) / 0.25 ), 0.0, 1.0 ) ), ( ( ( ( ( nodeVar93.xyz * vec3<f32>( nodeVar91.x ) ) + ( nodeVar94.xyz * vec3<f32>( nodeVar91.y ) ) ) + ( nodeVar95.xyz * vec3<f32>( nodeVar91.z ) ) ) + ( nodeVar96.xyz * vec3<f32>( nodeVar91.w ) ) ) + ( nodeVar97.xyz * vec3<f32>( max( ( 1.0 - ( ( ( nodeVar91.x + nodeVar91.y ) + nodeVar91.z ) + nodeVar91.w ) ), 0.0 ) ) ) ), object.nodeUniform29 );
	NodeBuffer_1133.value[ 0u ] = vec4<f32>( nodeVar98.x, nodeVar98.y, nodeVar98.z, nodeVar36 );

	

}
