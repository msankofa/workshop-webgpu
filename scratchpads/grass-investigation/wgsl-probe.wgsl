// Three.js r184 - Node System

// directives
enable subgroups;

// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms
@binding( 2 ) @group( 0 ) var nodeUniform6 : texture_2d<f32>;
@binding( 3 ) @group( 0 ) var nodeUniform12 : texture_2d<f32>;
@binding( 4 ) @group( 0 ) var nodeUniform15 : texture_2d<f32>;
@binding( 5 ) @group( 0 ) var nodeUniform17 : texture_2d<f32>;
@binding( 6 ) @group( 0 ) var nodeUniform21 : texture_2d<f32>;
@binding( 7 ) @group( 0 ) var nodeUniform29 : texture_2d<f32>;
@binding( 8 ) @group( 0 ) var nodeUniform35 : texture_2d<f32>;
@binding( 9 ) @group( 0 ) var nodeUniform44 : texture_2d<f32>;
@binding( 10 ) @group( 0 ) var nodeUniform47 : texture_2d<f32>;
@binding( 11 ) @group( 0 ) var nodeUniform59_sampler : sampler;
@binding( 12 ) @group( 0 ) var nodeUniform59 : texture_2d<f32>;
@binding( 13 ) @group( 0 ) var nodeUniform62_sampler : sampler;
@binding( 14 ) @group( 0 ) var nodeUniform62 : texture_2d<f32>;
@binding( 15 ) @group( 0 ) var nodeUniform63_sampler : sampler;
@binding( 16 ) @group( 0 ) var nodeUniform63 : texture_2d<f32>;
@binding( 17 ) @group( 0 ) var nodeUniform64_sampler : sampler;
@binding( 18 ) @group( 0 ) var nodeUniform64 : texture_2d<f32>;
@binding( 19 ) @group( 0 ) var nodeUniform65_sampler : sampler;
@binding( 20 ) @group( 0 ) var nodeUniform65 : texture_2d<f32>;
@binding( 21 ) @group( 0 ) var nodeUniform69 : texture_2d<f32>;

struct NodeBuffer_1333Struct {
	value : array< vec4<f32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> NodeBuffer_1333 : NodeBuffer_1333Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform2 : vec2<f32>,
	nodeUniform3 : vec3<f32>,
	nodeUniform4 : vec2<f32>,
	nodeUniform5 : vec2<f32>,
	nodeUniform7 : mat3x3<f32>,
	nodeUniform8 : mat3x3<f32>,
	nodeUniform9 : f32,
	nodeUniform10 : vec2<f32>,
	nodeUniform11 : f32,
	nodeUniform13 : i32,
	nodeUniform14 : i32,
	nodeUniform16 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : vec2<f32>,
	nodeUniform20 : f32,
	nodeUniform22 : f32,
	nodeUniform23 : vec2<f32>,
	nodeUniform24 : f32,
	nodeUniform25 : vec2<f32>,
	nodeUniform26 : f32,
	nodeUniform27 : vec2<f32>,
	nodeUniform28 : f32,
	nodeUniform30 : f32,
	nodeUniform31 : vec2<f32>,
	nodeUniform32 : f32,
	nodeUniform33 : vec2<f32>,
	nodeUniform34 : f32,
	nodeUniform36 : f32,
	nodeUniform37 : vec2<f32>,
	nodeUniform38 : f32,
	nodeUniform39 : vec2<f32>,
	nodeUniform40 : vec2<f32>,
	nodeUniform41 : f32,
	nodeUniform42 : vec2<f32>,
	nodeUniform43 : f32,
	nodeUniform45 : i32,
	nodeUniform46 : i32,
	nodeUniform48 : vec2<f32>,
	nodeUniform49 : f32,
	nodeUniform50 : f32,
	nodeUniform51 : f32,
	nodeUniform52 : f32,
	nodeUniform53 : f32,
	nodeUniform54 : f32,
	nodeUniform55 : f32,
	nodeUniform56 : f32,
	nodeUniform57 : f32,
	nodeUniform58 : f32,
	nodeUniform60 : f32,
	nodeUniform61 : f32,
	nodeUniform66 : f32,
	nodeUniform67 : mat3x3<f32>,
	nodeUniform68 : f32,
	nodeUniform70 : f32,
	nodeUniform71 : vec2<f32>,
	nodeUniform72 : f32,
	nodeUniform73 : vec2<f32>,
	nodeUniform74 : f32,
	nodeUniform75 : f32,
	nodeUniform76 : f32,
	nodeUniform77 : f32,
	nodeUniform78 : f32,
	nodeUniform79 : u32
};
@binding( 1 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : vec3<f32>;
var<private> nodeVar1 : f32;
var<private> nodeVar2 : vec2<f32>;
var<private> nodeVar3 : vec2<f32>;
var<private> nodeVar4 : vec2<f32>;
var<private> nodeVar5 : vec4<f32>;
var<private> nodeVar6 : vec2<u32>;
var<private> nodeVar7 : vec4<f32>;
var<private> nodeVar8 : f32;
var<private> nodeVar9 : f32;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : vec2<f32>;
var<private> nodeVar14 : vec2<i32>;
var<private> nodeVar15 : vec4<f32>;
var<private> nodeVar16 : vec2<i32>;
var<private> nodeVar17 : vec4<f32>;
var<private> nodeVar18 : vec4<f32>;
var<private> nodeVar19 : vec4<f32>;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec2<f32>;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec2<f32>;
var<private> nodeVar24 : vec4<f32>;
var<private> nodeVar25 : vec4<f32>;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec2<f32>;
var<private> nodeVar28 : vec2<f32>;
var<private> nodeVar29 : vec4<f32>;
var<private> nodeVar30 : vec2<f32>;
var<private> nodeVar31 : vec4<f32>;
var<private> nodeVar32 : vec2<f32>;
var<private> nodeVar33 : vec4<f32>;
var<private> nodeVar34 : vec4<f32>;
var<private> nodeVar35 : vec2<f32>;
var<private> nodeVar36 : vec2<f32>;
var<private> nodeVar37 : vec4<f32>;
var<private> nodeVar38 : vec2<f32>;
var<private> nodeVar39 : vec4<f32>;
var<private> nodeVar40 : vec2<f32>;
var<private> nodeVar41 : vec4<f32>;
var<private> nodeVar42 : vec4<f32>;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : vec2<f32>;
var<private> nodeVar45 : vec2<f32>;
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec2<f32>;
var<private> nodeVar48 : vec4<f32>;
var<private> nodeVar49 : vec2<f32>;
var<private> nodeVar50 : vec4<f32>;
var<private> nodeVar51 : vec4<f32>;
var<private> nodeVar52 : vec2<f32>;
var<private> nodeVar53 : vec2<f32>;
var<private> nodeVar54 : vec4<f32>;
var<private> nodeVar55 : vec2<f32>;
var<private> nodeVar56 : vec4<f32>;
var<private> nodeVar57 : vec2<f32>;
var<private> nodeVar58 : vec4<f32>;
var<private> nodeVar59 : vec4<f32>;
var<private> nodeVar60 : vec2<f32>;
var<private> nodeVar61 : vec2<f32>;
var<private> nodeVar62 : vec4<f32>;
var<private> nodeVar63 : vec2<f32>;
var<private> nodeVar64 : vec4<f32>;
var<private> nodeVar65 : vec2<f32>;
var<private> nodeVar66 : vec4<f32>;
var<private> nodeVar67 : vec4<f32>;
var<private> nodeVar68 : vec2<f32>;
var<private> nodeVar69 : vec2<f32>;
var<private> nodeVar70 : vec4<f32>;
var<private> nodeVar71 : vec2<f32>;
var<private> nodeVar72 : vec4<f32>;
var<private> nodeVar73 : vec2<f32>;
var<private> nodeVar74 : vec4<f32>;
var<private> nodeVar75 : vec4<f32>;
var<private> nodeVar76 : f32;
var<private> nodeVar77 : f32;
var<private> nodeVar78 : vec2<f32>;
var<private> nodeVar79 : vec2<f32>;
var<private> nodeVar80 : vec2<f32>;
var<private> nodeVar81 : vec2<i32>;
var<private> nodeVar82 : vec4<f32>;
var<private> nodeVar83 : vec2<i32>;
var<private> nodeVar84 : vec4<f32>;
var<private> nodeVar85 : vec4<f32>;
var<private> nodeVar86 : vec4<f32>;
var<private> nodeVar87 : vec4<f32>;
var<private> nodeVar88 : vec2<f32>;
var<private> nodeVar89 : vec4<f32>;
var<private> nodeVar90 : vec2<f32>;
var<private> nodeVar91 : vec4<f32>;
var<private> nodeVar92 : vec4<f32>;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : vec2<f32>;
var<private> nodeVar97 : vec2<f32>;
var<private> nodeVar98 : vec4<f32>;
var<private> nodeVar99 : vec2<f32>;
var<private> nodeVar100 : vec4<f32>;
var<private> nodeVar101 : vec2<f32>;
var<private> nodeVar102 : vec4<f32>;
var<private> nodeVar103 : vec4<f32>;
var<private> nodeVar104 : vec2<f32>;
var<private> nodeVar105 : vec2<f32>;
var<private> nodeVar106 : vec4<f32>;
var<private> nodeVar107 : vec2<f32>;
var<private> nodeVar108 : vec4<f32>;
var<private> nodeVar109 : vec2<f32>;
var<private> nodeVar110 : vec4<f32>;
var<private> nodeVar111 : vec4<f32>;
var<private> nodeVar112 : f32;
var<private> nodeVar113 : vec2<f32>;
var<private> nodeVar114 : vec2<f32>;
var<private> nodeVar115 : vec4<f32>;
var<private> nodeVar116 : vec2<f32>;
var<private> nodeVar117 : vec4<f32>;
var<private> nodeVar118 : vec2<f32>;
var<private> nodeVar119 : vec4<f32>;
var<private> nodeVar120 : vec4<f32>;
var<private> nodeVar121 : vec2<f32>;
var<private> nodeVar122 : vec2<f32>;
var<private> nodeVar123 : vec4<f32>;
var<private> nodeVar124 : vec2<f32>;
var<private> nodeVar125 : vec4<f32>;
var<private> nodeVar126 : vec2<f32>;
var<private> nodeVar127 : vec4<f32>;
var<private> nodeVar128 : vec4<f32>;
var<private> nodeVar129 : vec2<f32>;
var<private> nodeVar130 : vec2<f32>;
var<private> nodeVar131 : vec4<f32>;
var<private> nodeVar132 : vec2<f32>;
var<private> nodeVar133 : vec4<f32>;
var<private> nodeVar134 : vec2<f32>;
var<private> nodeVar135 : vec4<f32>;
var<private> nodeVar136 : vec4<f32>;
var<private> nodeVar137 : vec2<f32>;
var<private> nodeVar138 : vec2<f32>;
var<private> nodeVar139 : vec4<f32>;
var<private> nodeVar140 : vec2<f32>;
var<private> nodeVar141 : vec4<f32>;
var<private> nodeVar142 : vec2<f32>;
var<private> nodeVar143 : vec4<f32>;
var<private> nodeVar144 : vec4<f32>;
var<private> nodeVar145 : f32;
var<private> nodeVar146 : f32;
var<private> nodeVar147 : vec2<f32>;
var<private> nodeVar148 : vec2<f32>;
var<private> nodeVar149 : vec2<f32>;
var<private> nodeVar150 : vec2<i32>;
var<private> nodeVar151 : vec4<f32>;
var<private> nodeVar152 : vec2<i32>;
var<private> nodeVar153 : vec4<f32>;
var<private> nodeVar154 : vec4<f32>;
var<private> nodeVar155 : vec4<f32>;
var<private> nodeVar156 : vec4<f32>;
var<private> nodeVar157 : vec2<f32>;
var<private> nodeVar158 : vec4<f32>;
var<private> nodeVar159 : vec2<f32>;
var<private> nodeVar160 : vec4<f32>;
var<private> nodeVar161 : vec4<f32>;
var<private> nodeVar162 : f32;
var<private> nodeVar163 : f32;
var<private> nodeVar164 : vec3<f32>;
var<private> nodeVar165 : vec3<f32>;
var<private> nodeVar166 : f32;
var<private> nodeVar167 : vec2<f32>;
var<private> nodeVar168 : vec2<f32>;
var<private> nodeVar169 : vec2<f32>;
var<private> nodeVar170 : vec2<f32>;
var<private> nodeVar171 : vec2<f32>;
var<private> nodeVar172 : vec2<i32>;
var<private> nodeVar173 : vec4<f32>;
var<private> nodeVar174 : vec2<i32>;
var<private> nodeVar175 : vec4<f32>;
var<private> nodeVar176 : vec4<f32>;
var<private> nodeVar177 : vec4<f32>;
var<private> nodeVar178 : vec4<f32>;
var<private> nodeVar179 : vec2<f32>;
var<private> nodeVar180 : vec4<f32>;
var<private> nodeVar181 : vec2<f32>;
var<private> nodeVar182 : vec4<f32>;
var<private> nodeVar183 : vec4<f32>;
var<private> nodeVar184 : f32;
var<private> nodeVar185 : vec2<f32>;
var<private> nodeVar186 : vec2<f32>;
var<private> nodeVar187 : vec2<f32>;
var<private> nodeVar188 : vec2<i32>;
var<private> nodeVar189 : vec4<f32>;
var<private> nodeVar190 : vec2<i32>;
var<private> nodeVar191 : vec4<f32>;
var<private> nodeVar192 : vec4<f32>;
var<private> nodeVar193 : vec4<f32>;
var<private> nodeVar194 : vec4<f32>;
var<private> nodeVar195 : vec2<f32>;
var<private> nodeVar196 : vec4<f32>;
var<private> nodeVar197 : vec2<f32>;
var<private> nodeVar198 : vec4<f32>;
var<private> nodeVar199 : vec4<f32>;
var<private> nodeVar200 : f32;
var<private> nodeVar201 : f32;
var<private> nodeVar202 : vec2<f32>;
var<private> nodeVar203 : vec2<f32>;
var<private> nodeVar204 : vec2<f32>;
var<private> nodeVar205 : vec2<i32>;
var<private> nodeVar206 : vec4<f32>;
var<private> nodeVar207 : vec2<i32>;
var<private> nodeVar208 : vec4<f32>;
var<private> nodeVar209 : vec4<f32>;
var<private> nodeVar210 : vec4<f32>;
var<private> nodeVar211 : vec4<f32>;
var<private> nodeVar212 : vec2<f32>;
var<private> nodeVar213 : vec4<f32>;
var<private> nodeVar214 : vec2<f32>;
var<private> nodeVar215 : vec4<f32>;
var<private> nodeVar216 : vec4<f32>;
var<private> nodeVar217 : f32;
var<private> nodeVar218 : vec2<f32>;
var<private> nodeVar219 : vec2<f32>;
var<private> nodeVar220 : vec2<f32>;
var<private> nodeVar221 : vec2<i32>;
var<private> nodeVar222 : vec4<f32>;
var<private> nodeVar223 : vec2<i32>;
var<private> nodeVar224 : vec4<f32>;
var<private> nodeVar225 : vec4<f32>;
var<private> nodeVar226 : vec4<f32>;
var<private> nodeVar227 : vec4<f32>;
var<private> nodeVar228 : vec2<f32>;
var<private> nodeVar229 : vec4<f32>;
var<private> nodeVar230 : vec2<f32>;
var<private> nodeVar231 : vec4<f32>;
var<private> nodeVar232 : vec4<f32>;
var<private> nodeVar233 : f32;
var<private> nodeVar234 : f32;
var<private> nodeVar235 : f32;
var<private> nodeVar236 : f32;
var<private> nodeVar237 : f32;
var<private> nodeVar238 : f32;
var<private> nodeVar239 : f32;
var<private> nodeVar240 : f32;
var<private> nodeVar241 : vec4<f32>;
var<private> nodeVar242 : vec2<f32>;
var<private> nodeVar243 : vec4<f32>;
var<private> nodeVar244 : vec4<f32>;
var<private> nodeVar245 : vec4<f32>;
var<private> nodeVar246 : vec4<f32>;
var<private> nodeVar247 : vec4<f32>;
var<private> nodeVar248 : vec3<f32>;
var<private> nodeVar249 : f32;
var<private> nodeVar250 : vec2<f32>;
var<private> nodeVar251 : vec2<f32>;
var<private> nodeVar252 : vec4<f32>;
var<private> nodeVar253 : f32;
var<private> nodeVar254 : vec2<f32>;
var<private> nodeVar255 : vec2<f32>;
var<private> nodeVar256 : vec2<f32>;
var<private> nodeVar257 : vec2<i32>;
var<private> nodeVar258 : vec4<f32>;
var<private> nodeVar259 : vec2<i32>;
var<private> nodeVar260 : vec4<f32>;
var<private> nodeVar261 : vec4<f32>;
var<private> nodeVar262 : vec4<f32>;
var<private> nodeVar263 : vec4<f32>;
var<private> nodeVar264 : vec2<f32>;
var<private> nodeVar265 : vec4<f32>;
var<private> nodeVar266 : vec2<f32>;
var<private> nodeVar267 : vec4<f32>;
var<private> nodeVar268 : vec4<f32>;
var<private> nodeVar269 : f32;
var<private> nodeVar270 : f32;
var<private> nodeVar271 : f32;

// codes
fn tsl_clampWrapping_float( coord: f32 ) -> f32 { return clamp( coord, 0.0, 1.0 ); }
fn tsl_coord_clampS_clamp_2dT( coord : vec2f ) -> vec2f {

	return vec2f(
		tsl_clampWrapping_float( coord.x ),
		tsl_clampWrapping_float( coord.y )
	);

}



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

	if ( instanceIndex >= object.nodeUniform79 ) { return; }

	nodeVar2 = vec2<f32>( object.nodeUniform3.x, object.nodeUniform3.z );
	nodeVar3 = ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) + nodeVar2 );
	nodeVar4 = ( ( nodeVar3 - object.nodeUniform4 ) / object.nodeUniform5 );
	nodeVar6 = textureDimensions( nodeUniform6, u32( 0 ) );
	nodeVar5 = textureLoad( nodeUniform6, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform7 * vec3<f32>( clamp( ( ( nodeVar3 - object.nodeUniform4 ) / object.nodeUniform5 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar6 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar6 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );

	if ( ( ( ( ( ( ( object.nodeUniform1 > 0.5 ) && ( nodeVar4.x > 0.0 ) ) && ( nodeVar4.x < 1.0 ) ) && ( nodeVar4.y > 0.0 ) ) && ( nodeVar4.y < 1.0 ) ) && ( nodeVar5.x >= 0.0 ) ) ) {

		nodeVar7 = textureLoad( nodeUniform6, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform8 * vec3<f32>( clamp( ( ( nodeVar3 - object.nodeUniform4 ) / object.nodeUniform5 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar6 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar6 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
		nodeVar1 = ( nodeVar7.x - object.nodeUniform3.y );

	} else {

		nodeVar10 = ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) + vec2<f32>( object.nodeUniform3.x, object.nodeUniform3.z ) );
		nodeVar11 = ( ( nodeVar10 / vec2<f32>( object.nodeUniform9 ) ) - object.nodeUniform10 );
		nodeVar12 = floor( nodeVar11 );
		nodeVar13 = ( nodeVar12 + object.nodeUniform10 );
		nodeVar14 = ( vec2<i32>( floor( ( nodeVar13 / vec2<f32>( f32( object.nodeUniform13 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar13 / vec2<f32>( f32( object.nodeUniform13 ) ) ) ) ).x ) / f32( object.nodeUniform14 ) ) ) ) ) * vec2<i32>( object.nodeUniform14 ) ) );
		nodeVar15 = textureLoad( nodeUniform12, nodeVar14, u32( 0u ) );
		nodeVar16 = ( vec2<i32>( floor( ( ( nodeVar13 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform13 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar13 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform13 ) ) ) ) ).x ) / f32( object.nodeUniform14 ) ) ) ) ) * vec2<i32>( object.nodeUniform14 ) ) );
		nodeVar17 = textureLoad( nodeUniform12, nodeVar16, u32( 0u ) );
		nodeVar18 = textureLoad( nodeUniform12, vec2<i32>( nodeVar16.x, nodeVar14.y ), u32( 0u ) );
		nodeVar19 = textureLoad( nodeUniform12, vec2<i32>( nodeVar14.x, nodeVar16.y ), u32( 0u ) );

		if ( ( ( ( ( ( ( ( ( nodeVar12.x >= 0.0 ) && ( nodeVar12.y >= 0.0 ) ) && ( nodeVar12.x < ( object.nodeUniform11 - 1.0 ) ) ) && ( nodeVar12.y < ( object.nodeUniform11 - 1.0 ) ) ) && ( nodeVar15.x > 0.5 ) ) && ( nodeVar17.x > 0.5 ) ) && ( nodeVar18.x > 0.5 ) ) && ( nodeVar19.x > 0.5 ) ) ) {

			nodeVar20 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar13 - ( floor( ( nodeVar13 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).x, vec2<i32>( ( nodeVar13 - ( floor( ( nodeVar13 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).y ), u32( 0u ) );
			nodeVar21 = ( nodeVar13 + vec2<f32>( 1.0 ) );
			nodeVar22 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar21 - ( floor( ( nodeVar21 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).x, vec2<i32>( ( nodeVar13 - ( floor( ( nodeVar13 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).y ), u32( 0u ) );
			nodeVar23 = fract( nodeVar11 );
			nodeVar24 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar13 - ( floor( ( nodeVar13 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).x, vec2<i32>( ( nodeVar21 - ( floor( ( nodeVar21 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).y ), u32( 0u ) );
			nodeVar25 = textureLoad( nodeUniform15, vec2<i32>( vec2<i32>( ( nodeVar21 - ( floor( ( nodeVar21 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).x, vec2<i32>( ( nodeVar21 - ( floor( ( nodeVar21 / vec2<f32>( object.nodeUniform11 ) ) ) * vec2<f32>( object.nodeUniform11 ) ) ) ).y ), u32( 0u ) );
			nodeVar9 = mix( mix( nodeVar20.x, nodeVar22.x, nodeVar23.x ), mix( nodeVar24.x, nodeVar25.x, nodeVar23.x ), nodeVar23.y );

		} else {

			nodeVar9 = -1000000.0;

		}


		if ( ( nodeVar9 > -500000.0 ) ) {


			if ( ( object.nodeUniform16 > 0.5 ) ) {

				nodeVar27 = ( nodeVar10 / vec2<f32>( object.nodeUniform18 ) );
				nodeVar28 = clamp( floor( nodeVar27 ), object.nodeUniform19, ( ( object.nodeUniform19 + vec2<f32>( object.nodeUniform20 ) ) - vec2<f32>( 2.0 ) ) );
				nodeVar29 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar28 - ( floor( ( nodeVar28 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar28 - ( floor( ( nodeVar28 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar30 = ( nodeVar28 + vec2<f32>( 1.0 ) );
				nodeVar31 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar30 - ( floor( ( nodeVar30 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar28 - ( floor( ( nodeVar28 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar32 = clamp( ( nodeVar27 - nodeVar28 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
				nodeVar33 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar28 - ( floor( ( nodeVar28 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar30 - ( floor( ( nodeVar30 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar34 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar30 - ( floor( ( nodeVar30 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar30 - ( floor( ( nodeVar30 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar35 = ( nodeVar10 / vec2<f32>( object.nodeUniform22 ) );
				nodeVar36 = clamp( floor( nodeVar35 ), object.nodeUniform23, ( ( object.nodeUniform23 + vec2<f32>( object.nodeUniform24 ) ) - vec2<f32>( 2.0 ) ) );
				nodeVar37 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar36 - ( floor( ( nodeVar36 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar36 - ( floor( ( nodeVar36 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar38 = ( nodeVar36 + vec2<f32>( 1.0 ) );
				nodeVar39 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar38 - ( floor( ( nodeVar38 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar36 - ( floor( ( nodeVar36 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar40 = clamp( ( nodeVar35 - nodeVar36 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
				nodeVar41 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar36 - ( floor( ( nodeVar36 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar38 - ( floor( ( nodeVar38 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar42 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar38 - ( floor( ( nodeVar38 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar38 - ( floor( ( nodeVar38 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar43 = mix( mix( mix( nodeVar29.x, nodeVar31.x, nodeVar32.x ), mix( nodeVar33.x, nodeVar34.x, nodeVar32.x ), nodeVar32.y ), mix( mix( nodeVar37.x, nodeVar39.x, nodeVar40.x ), mix( nodeVar41.x, nodeVar42.x, nodeVar40.x ), nodeVar40.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform25.x ) ), abs( ( nodeVar10.y - object.nodeUniform25.y ) ) ) / object.nodeUniform26 ) ) );

				if ( ( max( abs( ( nodeVar10.x - object.nodeUniform27.x ) ), abs( ( nodeVar10.y - object.nodeUniform27.y ) ) ) < object.nodeUniform28 ) ) {

					nodeVar44 = ( nodeVar10 / vec2<f32>( object.nodeUniform30 ) );
					nodeVar45 = clamp( floor( nodeVar44 ), object.nodeUniform31, ( ( object.nodeUniform31 + vec2<f32>( object.nodeUniform32 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar46 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar47 = ( nodeVar45 + vec2<f32>( 1.0 ) );
					nodeVar48 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar49 = clamp( ( nodeVar44 - nodeVar45 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar50 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar45 - ( floor( ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar51 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar47 - ( floor( ( nodeVar47 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar52 = ( nodeVar10 / vec2<f32>( object.nodeUniform18 ) );
					nodeVar53 = clamp( floor( nodeVar52 ), object.nodeUniform19, ( ( object.nodeUniform19 + vec2<f32>( object.nodeUniform20 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar54 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar53 - ( floor( ( nodeVar53 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar53 - ( floor( ( nodeVar53 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar55 = ( nodeVar53 + vec2<f32>( 1.0 ) );
					nodeVar56 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar53 - ( floor( ( nodeVar53 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar57 = clamp( ( nodeVar52 - nodeVar53 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar58 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar53 - ( floor( ( nodeVar53 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar59 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar55 - ( floor( ( nodeVar55 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar43 = mix( mix( mix( nodeVar46.x, nodeVar48.x, nodeVar49.x ), mix( nodeVar50.x, nodeVar51.x, nodeVar49.x ), nodeVar49.y ), mix( mix( nodeVar54.x, nodeVar56.x, nodeVar57.x ), mix( nodeVar58.x, nodeVar59.x, nodeVar57.x ), nodeVar57.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform27.x ) ), abs( ( nodeVar10.y - object.nodeUniform27.y ) ) ) / object.nodeUniform28 ) ) );
					

				}


				if ( ( max( abs( ( nodeVar10.x - object.nodeUniform33.x ) ), abs( ( nodeVar10.y - object.nodeUniform33.y ) ) ) < object.nodeUniform34 ) ) {

					nodeVar60 = ( nodeVar10 / vec2<f32>( object.nodeUniform36 ) );
					nodeVar61 = clamp( floor( nodeVar60 ), object.nodeUniform37, ( ( object.nodeUniform37 + vec2<f32>( object.nodeUniform38 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar62 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar61 - ( floor( ( nodeVar61 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar61 - ( floor( ( nodeVar61 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar63 = ( nodeVar61 + vec2<f32>( 1.0 ) );
					nodeVar64 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar61 - ( floor( ( nodeVar61 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar65 = clamp( ( nodeVar60 - nodeVar61 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar66 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar61 - ( floor( ( nodeVar61 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar67 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar68 = ( nodeVar10 / vec2<f32>( object.nodeUniform30 ) );
					nodeVar69 = clamp( floor( nodeVar68 ), object.nodeUniform31, ( ( object.nodeUniform31 + vec2<f32>( object.nodeUniform32 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar70 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar69 - ( floor( ( nodeVar69 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar69 - ( floor( ( nodeVar69 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar71 = ( nodeVar69 + vec2<f32>( 1.0 ) );
					nodeVar72 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar69 - ( floor( ( nodeVar69 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar73 = clamp( ( nodeVar68 - nodeVar69 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar74 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar69 - ( floor( ( nodeVar69 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar75 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar43 = mix( mix( mix( nodeVar62.x, nodeVar64.x, nodeVar65.x ), mix( nodeVar66.x, nodeVar67.x, nodeVar65.x ), nodeVar65.y ), mix( mix( nodeVar70.x, nodeVar72.x, nodeVar73.x ), mix( nodeVar74.x, nodeVar75.x, nodeVar73.x ), nodeVar73.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform33.x ) ), abs( ( nodeVar10.y - object.nodeUniform33.y ) ) ) / object.nodeUniform34 ) ) );
					

				}


				if ( ( ( ( ( nodeVar10.x > object.nodeUniform39.x ) && ( nodeVar10.x < object.nodeUniform40.x ) ) && ( nodeVar10.y > object.nodeUniform39.y ) ) && ( nodeVar10.y < object.nodeUniform40.y ) ) ) {

					nodeVar76 = 0.0;

				} else {

					nodeVar76 = -0.25;

				}

				nodeVar26 = ( nodeVar43 + nodeVar76 );

			} else {

				nodeVar78 = ( ( nodeVar10 / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
				nodeVar79 = floor( nodeVar78 );
				nodeVar80 = ( nodeVar79 + object.nodeUniform42 );
				nodeVar81 = ( vec2<i32>( floor( ( nodeVar80 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar80 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
				nodeVar82 = textureLoad( nodeUniform44, nodeVar81, u32( 0u ) );
				nodeVar83 = ( vec2<i32>( floor( ( ( nodeVar80 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar80 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
				nodeVar84 = textureLoad( nodeUniform44, nodeVar83, u32( 0u ) );
				nodeVar85 = textureLoad( nodeUniform44, vec2<i32>( nodeVar83.x, nodeVar81.y ), u32( 0u ) );
				nodeVar86 = textureLoad( nodeUniform44, vec2<i32>( nodeVar81.x, nodeVar83.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar79.x >= 0.0 ) && ( nodeVar79.y >= 0.0 ) ) && ( nodeVar79.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar79.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar82.x > 0.5 ) ) && ( nodeVar84.x > 0.5 ) ) && ( nodeVar85.x > 0.5 ) ) && ( nodeVar86.x > 0.5 ) ) ) {

					nodeVar87 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar88 = ( nodeVar80 + vec2<f32>( 1.0 ) );
					nodeVar89 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar90 = fract( nodeVar78 );
					nodeVar91 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar92 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar77 = mix( mix( nodeVar87.x, nodeVar89.x, nodeVar90.x ), mix( nodeVar91.x, nodeVar92.x, nodeVar90.x ), nodeVar90.y );

				} else {

					nodeVar77 = -1000000.0;

				}

				nodeVar26 = nodeVar77;

			}


			if ( ( nodeVar26 > -500000.0 ) ) {

				nodeVar93 = clamp( ( ( length( ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) - object.nodeUniform48 ) ) - object.nodeUniform49 ) / object.nodeUniform50 ), 0.0, 1.0 );

			} else {

				nodeVar93 = 0.0;

			}

			nodeVar8 = mix( nodeVar9, nodeVar26, nodeVar93 );

		} else {


			if ( ( object.nodeUniform16 > 0.5 ) ) {

				nodeVar96 = ( nodeVar10 / vec2<f32>( object.nodeUniform18 ) );
				nodeVar97 = clamp( floor( nodeVar96 ), object.nodeUniform19, ( ( object.nodeUniform19 + vec2<f32>( object.nodeUniform20 ) ) - vec2<f32>( 2.0 ) ) );
				nodeVar98 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar99 = ( nodeVar97 + vec2<f32>( 1.0 ) );
				nodeVar100 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar99 - ( floor( ( nodeVar99 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar101 = clamp( ( nodeVar96 - nodeVar97 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
				nodeVar102 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar97 - ( floor( ( nodeVar97 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar99 - ( floor( ( nodeVar99 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar103 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar99 - ( floor( ( nodeVar99 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar99 - ( floor( ( nodeVar99 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
				nodeVar104 = ( nodeVar10 / vec2<f32>( object.nodeUniform22 ) );
				nodeVar105 = clamp( floor( nodeVar104 ), object.nodeUniform23, ( ( object.nodeUniform23 + vec2<f32>( object.nodeUniform24 ) ) - vec2<f32>( 2.0 ) ) );
				nodeVar106 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar105 - ( floor( ( nodeVar105 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar105 - ( floor( ( nodeVar105 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar107 = ( nodeVar105 + vec2<f32>( 1.0 ) );
				nodeVar108 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar107 - ( floor( ( nodeVar107 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar105 - ( floor( ( nodeVar105 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar109 = clamp( ( nodeVar104 - nodeVar105 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
				nodeVar110 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar105 - ( floor( ( nodeVar105 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar107 - ( floor( ( nodeVar107 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar111 = textureLoad( nodeUniform21, vec2<i32>( vec2<i32>( ( nodeVar107 - ( floor( ( nodeVar107 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).x, vec2<i32>( ( nodeVar107 - ( floor( ( nodeVar107 / vec2<f32>( object.nodeUniform24 ) ) ) * vec2<f32>( object.nodeUniform24 ) ) ) ).y ), u32( 0u ) );
				nodeVar112 = mix( mix( mix( nodeVar98.x, nodeVar100.x, nodeVar101.x ), mix( nodeVar102.x, nodeVar103.x, nodeVar101.x ), nodeVar101.y ), mix( mix( nodeVar106.x, nodeVar108.x, nodeVar109.x ), mix( nodeVar110.x, nodeVar111.x, nodeVar109.x ), nodeVar109.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform25.x ) ), abs( ( nodeVar10.y - object.nodeUniform25.y ) ) ) / object.nodeUniform26 ) ) );

				if ( ( max( abs( ( nodeVar10.x - object.nodeUniform27.x ) ), abs( ( nodeVar10.y - object.nodeUniform27.y ) ) ) < object.nodeUniform28 ) ) {

					nodeVar113 = ( nodeVar10 / vec2<f32>( object.nodeUniform30 ) );
					nodeVar114 = clamp( floor( nodeVar113 ), object.nodeUniform31, ( ( object.nodeUniform31 + vec2<f32>( object.nodeUniform32 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar115 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar114 - ( floor( ( nodeVar114 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar114 - ( floor( ( nodeVar114 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar116 = ( nodeVar114 + vec2<f32>( 1.0 ) );
					nodeVar117 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar114 - ( floor( ( nodeVar114 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar118 = clamp( ( nodeVar113 - nodeVar114 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar119 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar114 - ( floor( ( nodeVar114 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar120 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar116 - ( floor( ( nodeVar116 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar121 = ( nodeVar10 / vec2<f32>( object.nodeUniform18 ) );
					nodeVar122 = clamp( floor( nodeVar121 ), object.nodeUniform19, ( ( object.nodeUniform19 + vec2<f32>( object.nodeUniform20 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar123 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar122 - ( floor( ( nodeVar122 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar122 - ( floor( ( nodeVar122 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar124 = ( nodeVar122 + vec2<f32>( 1.0 ) );
					nodeVar125 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar124 - ( floor( ( nodeVar124 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar122 - ( floor( ( nodeVar122 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar126 = clamp( ( nodeVar121 - nodeVar122 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar127 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar122 - ( floor( ( nodeVar122 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar124 - ( floor( ( nodeVar124 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar128 = textureLoad( nodeUniform17, vec2<i32>( vec2<i32>( ( nodeVar124 - ( floor( ( nodeVar124 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).x, vec2<i32>( ( nodeVar124 - ( floor( ( nodeVar124 / vec2<f32>( object.nodeUniform20 ) ) ) * vec2<f32>( object.nodeUniform20 ) ) ) ).y ), u32( 0u ) );
					nodeVar112 = mix( mix( mix( nodeVar115.x, nodeVar117.x, nodeVar118.x ), mix( nodeVar119.x, nodeVar120.x, nodeVar118.x ), nodeVar118.y ), mix( mix( nodeVar123.x, nodeVar125.x, nodeVar126.x ), mix( nodeVar127.x, nodeVar128.x, nodeVar126.x ), nodeVar126.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform27.x ) ), abs( ( nodeVar10.y - object.nodeUniform27.y ) ) ) / object.nodeUniform28 ) ) );
					

				}


				if ( ( max( abs( ( nodeVar10.x - object.nodeUniform33.x ) ), abs( ( nodeVar10.y - object.nodeUniform33.y ) ) ) < object.nodeUniform34 ) ) {

					nodeVar129 = ( nodeVar10 / vec2<f32>( object.nodeUniform36 ) );
					nodeVar130 = clamp( floor( nodeVar129 ), object.nodeUniform37, ( ( object.nodeUniform37 + vec2<f32>( object.nodeUniform38 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar131 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar130 - ( floor( ( nodeVar130 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar130 - ( floor( ( nodeVar130 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar132 = ( nodeVar130 + vec2<f32>( 1.0 ) );
					nodeVar133 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar130 - ( floor( ( nodeVar130 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar134 = clamp( ( nodeVar129 - nodeVar130 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar135 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar130 - ( floor( ( nodeVar130 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar136 = textureLoad( nodeUniform35, vec2<i32>( vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).x, vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform38 ) ) ) * vec2<f32>( object.nodeUniform38 ) ) ) ).y ), u32( 0u ) );
					nodeVar137 = ( nodeVar10 / vec2<f32>( object.nodeUniform30 ) );
					nodeVar138 = clamp( floor( nodeVar137 ), object.nodeUniform31, ( ( object.nodeUniform31 + vec2<f32>( object.nodeUniform32 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar139 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar138 - ( floor( ( nodeVar138 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar138 - ( floor( ( nodeVar138 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar140 = ( nodeVar138 + vec2<f32>( 1.0 ) );
					nodeVar141 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar138 - ( floor( ( nodeVar138 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar142 = clamp( ( nodeVar137 - nodeVar138 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar143 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar138 - ( floor( ( nodeVar138 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar144 = textureLoad( nodeUniform29, vec2<i32>( vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).x, vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform32 ) ) ) * vec2<f32>( object.nodeUniform32 ) ) ) ).y ), u32( 0u ) );
					nodeVar112 = mix( mix( mix( nodeVar131.x, nodeVar133.x, nodeVar134.x ), mix( nodeVar135.x, nodeVar136.x, nodeVar134.x ), nodeVar134.y ), mix( mix( nodeVar139.x, nodeVar141.x, nodeVar142.x ), mix( nodeVar143.x, nodeVar144.x, nodeVar142.x ), nodeVar142.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar10.x - object.nodeUniform33.x ) ), abs( ( nodeVar10.y - object.nodeUniform33.y ) ) ) / object.nodeUniform34 ) ) );
					

				}


				if ( ( ( ( ( nodeVar10.x > object.nodeUniform39.x ) && ( nodeVar10.x < object.nodeUniform40.x ) ) && ( nodeVar10.y > object.nodeUniform39.y ) ) && ( nodeVar10.y < object.nodeUniform40.y ) ) ) {

					nodeVar145 = 0.0;

				} else {

					nodeVar145 = -0.25;

				}

				nodeVar95 = ( nodeVar112 + nodeVar145 );

			} else {

				nodeVar147 = ( ( nodeVar10 / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
				nodeVar148 = floor( nodeVar147 );
				nodeVar149 = ( nodeVar148 + object.nodeUniform42 );
				nodeVar150 = ( vec2<i32>( floor( ( nodeVar149 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar149 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
				nodeVar151 = textureLoad( nodeUniform44, nodeVar150, u32( 0u ) );
				nodeVar152 = ( vec2<i32>( floor( ( ( nodeVar149 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar149 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
				nodeVar153 = textureLoad( nodeUniform44, nodeVar152, u32( 0u ) );
				nodeVar154 = textureLoad( nodeUniform44, vec2<i32>( nodeVar152.x, nodeVar150.y ), u32( 0u ) );
				nodeVar155 = textureLoad( nodeUniform44, vec2<i32>( nodeVar150.x, nodeVar152.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar148.x >= 0.0 ) && ( nodeVar148.y >= 0.0 ) ) && ( nodeVar148.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar148.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar151.x > 0.5 ) ) && ( nodeVar153.x > 0.5 ) ) && ( nodeVar154.x > 0.5 ) ) && ( nodeVar155.x > 0.5 ) ) ) {

					nodeVar156 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar157 = ( nodeVar149 + vec2<f32>( 1.0 ) );
					nodeVar158 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar159 = fract( nodeVar147 );
					nodeVar160 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar161 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
					nodeVar146 = mix( mix( nodeVar156.x, nodeVar158.x, nodeVar159.x ), mix( nodeVar160.x, nodeVar161.x, nodeVar159.x ), nodeVar159.y );

				} else {

					nodeVar146 = -1000000.0;

				}

				nodeVar95 = nodeVar146;

			}


			if ( ( nodeVar95 > -500000.0 ) ) {

				nodeVar94 = nodeVar95;

			} else {

				nodeVar94 = -100000.0;

			}

			nodeVar8 = nodeVar94;

		}

		nodeVar1 = ( nodeVar8 - object.nodeUniform3.y );

	}

	nodeVar162 = ( nodeVar1 + object.nodeUniform3.y );
	nodeVar163 = ( nodeVar162 - object.nodeUniform51 );

	if ( ( nodeVar163 < 0.0 ) ) {

		nodeVar0 = mix( vec3<f32>( 0.16, 0.32, 0.42 ), vec3<f32>( 0.72, 0.66, 0.46 ), clamp( ( 1.0 + ( nodeVar163 / 6.0 ) ), 0.0, 1.0 ) );

	} else {


		if ( ( nodeVar163 < 2.0 ) ) {

			nodeVar164 = mix( vec3<f32>( 0.72, 0.66, 0.46 ), vec3<f32>( 0.3, 0.48, 0.22 ), clamp( ( nodeVar163 / 2.0 ), 0.0, 1.0 ) );

		} else {


			if ( ( nodeVar163 < 60.0 ) ) {

				nodeVar165 = mix( vec3<f32>( 0.3, 0.48, 0.22 ), vec3<f32>( 0.46, 0.44, 0.28 ), clamp( ( ( nodeVar163 - 20.0 ) / 40.0 ), 0.0, 1.0 ) );

			} else {

				nodeVar165 = mix( vec3<f32>( 0.46, 0.44, 0.28 ), vec3<f32>( 0.92, 0.93, 0.95 ), clamp( ( ( nodeVar163 - 60.0 ) / 40.0 ), 0.0, 1.0 ) );

			}

			nodeVar164 = nodeVar165;

		}

		nodeVar0 = nodeVar164;

	}

	nodeVar167 = vec2<f32>( object.nodeUniform3.x, object.nodeUniform3.z );
	nodeVar168 = ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) + nodeVar167 );
	nodeVar169 = ( ( vec2<f32>( ( nodeVar168.x + 8.0 ), nodeVar168.y ) / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
	nodeVar170 = floor( nodeVar169 );
	nodeVar171 = ( nodeVar170 + object.nodeUniform42 );
	nodeVar172 = ( vec2<i32>( floor( ( nodeVar171 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar171 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar173 = textureLoad( nodeUniform44, nodeVar172, u32( 0u ) );
	nodeVar174 = ( vec2<i32>( floor( ( ( nodeVar171 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar171 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar175 = textureLoad( nodeUniform44, nodeVar174, u32( 0u ) );
	nodeVar176 = textureLoad( nodeUniform44, vec2<i32>( nodeVar174.x, nodeVar172.y ), u32( 0u ) );
	nodeVar177 = textureLoad( nodeUniform44, vec2<i32>( nodeVar172.x, nodeVar174.y ), u32( 0u ) );

	if ( ( ( ( ( ( ( ( ( nodeVar170.x >= 0.0 ) && ( nodeVar170.y >= 0.0 ) ) && ( nodeVar170.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar170.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar173.x > 0.5 ) ) && ( nodeVar175.x > 0.5 ) ) && ( nodeVar176.x > 0.5 ) ) && ( nodeVar177.x > 0.5 ) ) ) {

		nodeVar178 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar171 - ( floor( ( nodeVar171 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar171 - ( floor( ( nodeVar171 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar179 = ( nodeVar171 + vec2<f32>( 1.0 ) );
		nodeVar180 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar179 - ( floor( ( nodeVar179 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar171 - ( floor( ( nodeVar171 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar181 = fract( nodeVar169 );
		nodeVar182 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar171 - ( floor( ( nodeVar171 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar179 - ( floor( ( nodeVar179 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar183 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar179 - ( floor( ( nodeVar179 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar179 - ( floor( ( nodeVar179 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar166 = mix( mix( nodeVar178.x, nodeVar180.x, nodeVar181.x ), mix( nodeVar182.x, nodeVar183.x, nodeVar181.x ), nodeVar181.y );

	} else {

		nodeVar166 = nodeVar162;

	}

	nodeVar185 = ( ( vec2<f32>( ( nodeVar168.x - 8.0 ), nodeVar168.y ) / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
	nodeVar186 = floor( nodeVar185 );
	nodeVar187 = ( nodeVar186 + object.nodeUniform42 );
	nodeVar188 = ( vec2<i32>( floor( ( nodeVar187 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar187 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar189 = textureLoad( nodeUniform44, nodeVar188, u32( 0u ) );
	nodeVar190 = ( vec2<i32>( floor( ( ( nodeVar187 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar187 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar191 = textureLoad( nodeUniform44, nodeVar190, u32( 0u ) );
	nodeVar192 = textureLoad( nodeUniform44, vec2<i32>( nodeVar190.x, nodeVar188.y ), u32( 0u ) );
	nodeVar193 = textureLoad( nodeUniform44, vec2<i32>( nodeVar188.x, nodeVar190.y ), u32( 0u ) );

	if ( ( ( ( ( ( ( ( ( nodeVar186.x >= 0.0 ) && ( nodeVar186.y >= 0.0 ) ) && ( nodeVar186.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar186.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar189.x > 0.5 ) ) && ( nodeVar191.x > 0.5 ) ) && ( nodeVar192.x > 0.5 ) ) && ( nodeVar193.x > 0.5 ) ) ) {

		nodeVar194 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar187 - ( floor( ( nodeVar187 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar187 - ( floor( ( nodeVar187 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar195 = ( nodeVar187 + vec2<f32>( 1.0 ) );
		nodeVar196 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar195 - ( floor( ( nodeVar195 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar187 - ( floor( ( nodeVar187 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar197 = fract( nodeVar185 );
		nodeVar198 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar187 - ( floor( ( nodeVar187 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar195 - ( floor( ( nodeVar195 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar199 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar195 - ( floor( ( nodeVar195 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar195 - ( floor( ( nodeVar195 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar184 = mix( mix( nodeVar194.x, nodeVar196.x, nodeVar197.x ), mix( nodeVar198.x, nodeVar199.x, nodeVar197.x ), nodeVar197.y );

	} else {

		nodeVar184 = nodeVar162;

	}

	nodeVar200 = ( ( nodeVar166 - nodeVar184 ) / ( 8.0 * 2.0 ) );
	nodeVar202 = ( ( vec2<f32>( nodeVar168.x, ( nodeVar168.y + 8.0 ) ) / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
	nodeVar203 = floor( nodeVar202 );
	nodeVar204 = ( nodeVar203 + object.nodeUniform42 );
	nodeVar205 = ( vec2<i32>( floor( ( nodeVar204 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar204 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar206 = textureLoad( nodeUniform44, nodeVar205, u32( 0u ) );
	nodeVar207 = ( vec2<i32>( floor( ( ( nodeVar204 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar204 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar208 = textureLoad( nodeUniform44, nodeVar207, u32( 0u ) );
	nodeVar209 = textureLoad( nodeUniform44, vec2<i32>( nodeVar207.x, nodeVar205.y ), u32( 0u ) );
	nodeVar210 = textureLoad( nodeUniform44, vec2<i32>( nodeVar205.x, nodeVar207.y ), u32( 0u ) );

	if ( ( ( ( ( ( ( ( ( nodeVar203.x >= 0.0 ) && ( nodeVar203.y >= 0.0 ) ) && ( nodeVar203.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar203.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar206.x > 0.5 ) ) && ( nodeVar208.x > 0.5 ) ) && ( nodeVar209.x > 0.5 ) ) && ( nodeVar210.x > 0.5 ) ) ) {

		nodeVar211 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar204 - ( floor( ( nodeVar204 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar204 - ( floor( ( nodeVar204 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar212 = ( nodeVar204 + vec2<f32>( 1.0 ) );
		nodeVar213 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar212 - ( floor( ( nodeVar212 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar204 - ( floor( ( nodeVar204 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar214 = fract( nodeVar202 );
		nodeVar215 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar204 - ( floor( ( nodeVar204 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar212 - ( floor( ( nodeVar212 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar216 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar212 - ( floor( ( nodeVar212 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar212 - ( floor( ( nodeVar212 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar201 = mix( mix( nodeVar211.x, nodeVar213.x, nodeVar214.x ), mix( nodeVar215.x, nodeVar216.x, nodeVar214.x ), nodeVar214.y );

	} else {

		nodeVar201 = nodeVar162;

	}

	nodeVar218 = ( ( vec2<f32>( nodeVar168.x, ( nodeVar168.y - 8.0 ) ) / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
	nodeVar219 = floor( nodeVar218 );
	nodeVar220 = ( nodeVar219 + object.nodeUniform42 );
	nodeVar221 = ( vec2<i32>( floor( ( nodeVar220 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar220 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar222 = textureLoad( nodeUniform44, nodeVar221, u32( 0u ) );
	nodeVar223 = ( vec2<i32>( floor( ( ( nodeVar220 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar220 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
	nodeVar224 = textureLoad( nodeUniform44, nodeVar223, u32( 0u ) );
	nodeVar225 = textureLoad( nodeUniform44, vec2<i32>( nodeVar223.x, nodeVar221.y ), u32( 0u ) );
	nodeVar226 = textureLoad( nodeUniform44, vec2<i32>( nodeVar221.x, nodeVar223.y ), u32( 0u ) );

	if ( ( ( ( ( ( ( ( ( nodeVar219.x >= 0.0 ) && ( nodeVar219.y >= 0.0 ) ) && ( nodeVar219.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar219.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar222.x > 0.5 ) ) && ( nodeVar224.x > 0.5 ) ) && ( nodeVar225.x > 0.5 ) ) && ( nodeVar226.x > 0.5 ) ) ) {

		nodeVar227 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar220 - ( floor( ( nodeVar220 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar220 - ( floor( ( nodeVar220 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar228 = ( nodeVar220 + vec2<f32>( 1.0 ) );
		nodeVar229 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar228 - ( floor( ( nodeVar228 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar220 - ( floor( ( nodeVar220 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar230 = fract( nodeVar218 );
		nodeVar231 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar220 - ( floor( ( nodeVar220 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar228 - ( floor( ( nodeVar228 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar232 = textureLoad( nodeUniform47, vec2<i32>( vec2<i32>( ( nodeVar228 - ( floor( ( nodeVar228 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar228 - ( floor( ( nodeVar228 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
		nodeVar217 = mix( mix( nodeVar227.x, nodeVar229.x, nodeVar230.x ), mix( nodeVar231.x, nodeVar232.x, nodeVar230.x ), nodeVar230.y );

	} else {

		nodeVar217 = nodeVar162;

	}

	nodeVar233 = ( ( nodeVar201 - nodeVar217 ) / ( 8.0 * 2.0 ) );
	nodeVar234 = ( 1.0 / sqrt( ( ( ( nodeVar200 * nodeVar200 ) + ( nodeVar233 * nodeVar233 ) ) + 1.0 ) ) );
	nodeVar235 = ( 1.0 - smoothstep( ( object.nodeUniform52 - 1.5 ), ( object.nodeUniform52 + 1.5 ), nodeVar162 ) );
	nodeVar236 = ( 1.0 - smoothstep( object.nodeUniform53, object.nodeUniform54, nodeVar234 ) );
	nodeVar237 = ( 1.0 - nodeVar236 );
	nodeVar238 = ( 1.0 - nodeVar235 );
	nodeVar239 = smoothstep( object.nodeUniform55, object.nodeUniform56, nodeVar162 );
	nodeVar240 = smoothstep( object.nodeUniform57, object.nodeUniform58, nodeVar162 );
	nodeVar241 = vec4<f32>( ( nodeVar235 * nodeVar237 ), ( ( ( nodeVar238 * ( 1.0 - nodeVar239 ) ) * ( 1.0 - nodeVar240 ) ) * nodeVar237 ), ( ( ( nodeVar238 * nodeVar239 ) * ( 1.0 - nodeVar240 ) ) * nodeVar237 ), nodeVar236 );
	nodeVar242 = ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) * vec2<f32>( object.nodeUniform60 ) );
	nodeVar243 = textureSampleLevel( nodeUniform59, nodeUniform59_sampler, nodeVar242, object.nodeUniform61 );
	nodeVar244 = textureSampleLevel( nodeUniform62, nodeUniform62_sampler, nodeVar242, object.nodeUniform61 );
	nodeVar245 = textureSampleLevel( nodeUniform63, nodeUniform63_sampler, nodeVar242, object.nodeUniform61 );
	nodeVar246 = textureSampleLevel( nodeUniform64, nodeUniform64_sampler, nodeVar242, object.nodeUniform61 );
	nodeVar247 = textureSampleLevel( nodeUniform65, nodeUniform65_sampler, nodeVar242, object.nodeUniform61 );
	nodeVar248 = mix( mix( nodeVar0, vec3<f32>( 0.42, 0.4, 0.38 ), clamp( ( ( 0.82 - nodeVar234 ) / 0.25 ), 0.0, 1.0 ) ), ( ( ( ( ( nodeVar243.xyz * vec3<f32>( nodeVar241.x ) ) + ( nodeVar244.xyz * vec3<f32>( nodeVar241.y ) ) ) + ( nodeVar245.xyz * vec3<f32>( nodeVar241.z ) ) ) + ( nodeVar246.xyz * vec3<f32>( nodeVar241.w ) ) ) + ( nodeVar247.xyz * vec3<f32>( max( ( 1.0 - ( ( ( nodeVar241.x + nodeVar241.y ) + nodeVar241.z ) + nodeVar241.w ) ), 0.0 ) ) ) ), object.nodeUniform66 );
	NodeBuffer_1333.value[ 0u ] = vec4<f32>( nodeVar248.x, nodeVar248.y, nodeVar248.z, nodeVar1 );
	nodeVar250 = ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) + nodeVar2 );
	nodeVar251 = ( ( nodeVar250 - object.nodeUniform4 ) / object.nodeUniform5 );
	nodeVar252 = textureLoad( nodeUniform6, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform67 * vec3<f32>( clamp( ( ( nodeVar250 - object.nodeUniform4 ) / object.nodeUniform5 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar6 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar6 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );

	if ( ( ( ( ( ( ( object.nodeUniform1 > 0.5 ) && ( nodeVar251.x > 0.0 ) ) && ( nodeVar251.x < 1.0 ) ) && ( nodeVar251.y > 0.0 ) ) && ( nodeVar251.y < 1.0 ) ) && ( nodeVar252.x >= 0.0 ) ) ) {

		nodeVar249 = nodeVar252.x;

	} else {

		nodeVar254 = ( ( ( vec2<f32>( object.nodeUniform2.x, object.nodeUniform2.y ) + nodeVar167 ) / vec2<f32>( object.nodeUniform41 ) ) - object.nodeUniform42 );
		nodeVar255 = floor( nodeVar254 );
		nodeVar256 = ( nodeVar255 + object.nodeUniform42 );
		nodeVar257 = ( vec2<i32>( floor( ( nodeVar256 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar256 / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
		nodeVar258 = textureLoad( nodeUniform44, nodeVar257, u32( 0u ) );
		nodeVar259 = ( vec2<i32>( floor( ( ( nodeVar256 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar256 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform45 ) ) ) ) ).x ) / f32( object.nodeUniform46 ) ) ) ) ) * vec2<i32>( object.nodeUniform46 ) ) );
		nodeVar260 = textureLoad( nodeUniform44, nodeVar259, u32( 0u ) );
		nodeVar261 = textureLoad( nodeUniform44, vec2<i32>( nodeVar259.x, nodeVar257.y ), u32( 0u ) );
		nodeVar262 = textureLoad( nodeUniform44, vec2<i32>( nodeVar257.x, nodeVar259.y ), u32( 0u ) );

		if ( ( ( ( ( ( ( ( ( nodeVar255.x >= 0.0 ) && ( nodeVar255.y >= 0.0 ) ) && ( nodeVar255.x < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar255.y < ( object.nodeUniform43 - 1.0 ) ) ) && ( nodeVar258.x > 0.5 ) ) && ( nodeVar260.x > 0.5 ) ) && ( nodeVar261.x > 0.5 ) ) && ( nodeVar262.x > 0.5 ) ) ) {

			nodeVar263 = textureLoad( nodeUniform69, vec2<i32>( vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
			nodeVar264 = ( nodeVar256 + vec2<f32>( 1.0 ) );
			nodeVar265 = textureLoad( nodeUniform69, vec2<i32>( vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
			nodeVar266 = fract( nodeVar254 );
			nodeVar267 = textureLoad( nodeUniform69, vec2<i32>( vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
			nodeVar268 = textureLoad( nodeUniform69, vec2<i32>( vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).x, vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform43 ) ) ) * vec2<f32>( object.nodeUniform43 ) ) ) ).y ), u32( 0u ) );
			nodeVar253 = mix( mix( ( nodeVar263.x * 255.0 ), ( nodeVar265.x * 255.0 ), nodeVar266.x ), mix( ( nodeVar267.x * 255.0 ), ( nodeVar268.x * 255.0 ), nodeVar266.x ), nodeVar266.y );

		} else {

			nodeVar253 = 0.0;

		}

		nodeVar249 = clamp( max( ( ( 1.0 - object.nodeUniform68 ) + ( clamp( ( nodeVar253 / 255.0 ), 0.0, 1.0 ) * object.nodeUniform68 ) ), object.nodeUniform70 ), 0.0, 1.0 );

	}

	nodeVar270 = length( vec2<f32>( ( object.nodeUniform2.x - object.nodeUniform71.x ), ( object.nodeUniform2.y - object.nodeUniform71.y ) ) );

	if ( ( ( nodeVar270 < object.nodeUniform72 ) || ( dot( ( vec2<f32>( ( object.nodeUniform2.x - object.nodeUniform71.x ), ( object.nodeUniform2.y - object.nodeUniform71.y ) ) / vec2<f32>( max( nodeVar270, 0.001 ) ) ), object.nodeUniform73 ) > object.nodeUniform74 ) ) ) {

		nodeVar269 = 1.0;

	} else {

		nodeVar269 = 0.0;

	}


	if ( ( nodeVar1 > object.nodeUniform78 ) ) {

		nodeVar271 = 1.0;

	} else {

		nodeVar271 = 0.0;

	}

	NodeBuffer_1333.value[ 1u ] = vec4<f32>( nodeVar249, nodeVar269, pow( clamp( ( ( nodeVar270 - object.nodeUniform75 ) / max( ( object.nodeUniform76 - object.nodeUniform75 ), 0.001 ) ), 0.0, 1.0 ), object.nodeUniform77 ), nodeVar271 );

	

}
