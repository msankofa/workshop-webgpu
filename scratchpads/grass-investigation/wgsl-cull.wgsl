// Three.js r184 - Node System

// directives
enable subgroups;

// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms
@binding( 1 ) @group( 0 ) var nodeUniform16 : texture_2d<f32>;
@binding( 2 ) @group( 0 ) var nodeUniform22 : texture_2d<f32>;
@binding( 3 ) @group( 0 ) var nodeUniform25 : texture_2d<f32>;
@binding( 4 ) @group( 0 ) var nodeUniform27 : texture_2d<f32>;
@binding( 5 ) @group( 0 ) var nodeUniform31 : texture_2d<f32>;
@binding( 6 ) @group( 0 ) var nodeUniform39 : texture_2d<f32>;
@binding( 7 ) @group( 0 ) var nodeUniform45 : texture_2d<f32>;
@binding( 8 ) @group( 0 ) var nodeUniform54 : texture_2d<f32>;
@binding( 9 ) @group( 0 ) var nodeUniform57 : texture_2d<f32>;
@binding( 10 ) @group( 0 ) var nodeUniform75 : texture_2d<f32>;
@binding( 13 ) @group( 0 ) var nodeUniform89_sampler : sampler;
@binding( 14 ) @group( 0 ) var nodeUniform89 : texture_2d<f32>;
@binding( 15 ) @group( 0 ) var nodeUniform92_sampler : sampler;
@binding( 16 ) @group( 0 ) var nodeUniform92 : texture_2d<f32>;
@binding( 17 ) @group( 0 ) var nodeUniform93_sampler : sampler;
@binding( 18 ) @group( 0 ) var nodeUniform93 : texture_2d<f32>;
@binding( 19 ) @group( 0 ) var nodeUniform94_sampler : sampler;
@binding( 20 ) @group( 0 ) var nodeUniform94 : texture_2d<f32>;
@binding( 21 ) @group( 0 ) var nodeUniform95_sampler : sampler;
@binding( 22 ) @group( 0 ) var nodeUniform95 : texture_2d<f32>;

struct NodeBuffer_1266Struct {
	value : array< atomic<u32> >
};
@binding( 11 ) @group( 0 )
var<storage, read_write> NodeBuffer_1266 : NodeBuffer_1266Struct;

struct NodeBuffer_1265Struct {
	value : array< vec4<f32> >
};
@binding( 12 ) @group( 0 )
var<storage, read_write> NodeBuffer_1265 : NodeBuffer_1265Struct;

struct objectStruct {
	nodeUniform0 : i32,
	nodeUniform1 : i32,
	nodeUniform2 : i32,
	nodeUniform3 : i32,
	nodeUniform4 : i32,
	nodeUniform5 : i32,
	nodeUniform6 : i32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform9 : vec2<f32>,
	nodeUniform10 : f32,
	nodeUniform11 : i32,
	nodeUniform12 : i32,
	nodeUniform13 : vec3<f32>,
	nodeUniform14 : vec2<f32>,
	nodeUniform15 : vec2<f32>,
	nodeUniform17 : mat3x3<f32>,
	nodeUniform18 : mat3x3<f32>,
	nodeUniform19 : f32,
	nodeUniform20 : vec2<f32>,
	nodeUniform21 : f32,
	nodeUniform23 : i32,
	nodeUniform24 : i32,
	nodeUniform26 : f32,
	nodeUniform28 : f32,
	nodeUniform29 : vec2<f32>,
	nodeUniform30 : f32,
	nodeUniform32 : f32,
	nodeUniform33 : vec2<f32>,
	nodeUniform34 : f32,
	nodeUniform35 : vec2<f32>,
	nodeUniform36 : f32,
	nodeUniform37 : vec2<f32>,
	nodeUniform38 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : vec2<f32>,
	nodeUniform42 : f32,
	nodeUniform43 : vec2<f32>,
	nodeUniform44 : f32,
	nodeUniform46 : f32,
	nodeUniform47 : vec2<f32>,
	nodeUniform48 : f32,
	nodeUniform49 : vec2<f32>,
	nodeUniform50 : vec2<f32>,
	nodeUniform51 : f32,
	nodeUniform52 : vec2<f32>,
	nodeUniform53 : f32,
	nodeUniform55 : i32,
	nodeUniform56 : i32,
	nodeUniform58 : vec2<f32>,
	nodeUniform59 : f32,
	nodeUniform60 : f32,
	nodeUniform61 : f32,
	nodeUniform62 : f32,
	nodeUniform63 : f32,
	nodeUniform64 : f32,
	nodeUniform65 : f32,
	nodeUniform66 : f32,
	nodeUniform67 : f32,
	nodeUniform68 : vec2<f32>,
	nodeUniform69 : f32,
	nodeUniform70 : f32,
	nodeUniform71 : f32,
	nodeUniform72 : f32,
	nodeUniform73 : mat3x3<f32>,
	nodeUniform74 : f32,
	nodeUniform76 : f32,
	nodeUniform78 : u32,
	nodeUniform79 : u32,
	nodeUniform81 : f32,
	nodeUniform82 : f32,
	nodeUniform83 : f32,
	nodeUniform84 : f32,
	nodeUniform85 : f32,
	nodeUniform86 : f32,
	nodeUniform87 : f32,
	nodeUniform88 : f32,
	nodeUniform90 : f32,
	nodeUniform91 : f32,
	nodeUniform96 : f32,
	nodeUniform97 : u32
};
@binding( 0 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : i32;
var<private> nodeVar1 : bool;
var<private> nodeVar2 : i32;
var<private> nodeVar3 : i32;
var<private> nodeVar4 : i32;
var<private> nodeVar5 : i32;
var<private> nodeVar6 : i32;
var<private> nodeVar7 : i32;
var<private> nodeVar8 : i32;
var<private> nodeVar9 : i32;
var<private> nodeVar10 : i32;
var<private> nodeVar11 : i32;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : i32;
var<private> nodeVar14 : i32;
var<private> nodeVar15 : i32;
var<private> nodeVar16 : i32;
var<private> nodeVar17 : i32;
var<private> nodeVar18 : i32;
var<private> nodeVar19 : i32;
var<private> nodeVar20 : i32;
var<private> nodeVar21 : i32;
var<private> nodeVar22 : i32;
var<private> nodeVar23 : i32;
var<private> nodeVar24 : i32;
var<private> nodeVar25 : i32;
var<private> nodeVar26 : i32;
var<private> nodeVar27 : i32;
var<private> nodeVar28 : u32;
var<private> nodeVar29 : i32;
var<private> nodeVar30 : u32;
var<private> nodeVar31 : u32;
var<private> nodeVar32 : f32;
var<private> nodeVar33 : u32;
var<private> nodeVar34 : u32;
var<private> nodeVar35 : u32;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : vec2<f32>;
var<private> nodeVar38 : vec2<f32>;
var<private> nodeVar39 : vec2<f32>;
var<private> nodeVar40 : vec4<f32>;
var<private> nodeVar41 : vec2<u32>;
var<private> nodeVar42 : vec4<f32>;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : f32;
var<private> nodeVar45 : vec2<f32>;
var<private> nodeVar46 : vec2<f32>;
var<private> nodeVar47 : vec2<f32>;
var<private> nodeVar48 : vec2<f32>;
var<private> nodeVar49 : vec2<i32>;
var<private> nodeVar50 : vec4<f32>;
var<private> nodeVar51 : vec2<i32>;
var<private> nodeVar52 : vec4<f32>;
var<private> nodeVar53 : vec4<f32>;
var<private> nodeVar54 : vec4<f32>;
var<private> nodeVar55 : vec4<f32>;
var<private> nodeVar56 : vec2<f32>;
var<private> nodeVar57 : vec4<f32>;
var<private> nodeVar58 : vec2<f32>;
var<private> nodeVar59 : vec4<f32>;
var<private> nodeVar60 : vec4<f32>;
var<private> nodeVar61 : f32;
var<private> nodeVar62 : vec2<f32>;
var<private> nodeVar63 : vec2<f32>;
var<private> nodeVar64 : vec4<f32>;
var<private> nodeVar65 : vec2<f32>;
var<private> nodeVar66 : vec4<f32>;
var<private> nodeVar67 : vec2<f32>;
var<private> nodeVar68 : vec4<f32>;
var<private> nodeVar69 : vec4<f32>;
var<private> nodeVar70 : vec2<f32>;
var<private> nodeVar71 : vec2<f32>;
var<private> nodeVar72 : vec4<f32>;
var<private> nodeVar73 : vec2<f32>;
var<private> nodeVar74 : vec4<f32>;
var<private> nodeVar75 : vec2<f32>;
var<private> nodeVar76 : vec4<f32>;
var<private> nodeVar77 : vec4<f32>;
var<private> nodeVar78 : f32;
var<private> nodeVar79 : vec2<f32>;
var<private> nodeVar80 : vec2<f32>;
var<private> nodeVar81 : vec4<f32>;
var<private> nodeVar82 : vec2<f32>;
var<private> nodeVar83 : vec4<f32>;
var<private> nodeVar84 : vec2<f32>;
var<private> nodeVar85 : vec4<f32>;
var<private> nodeVar86 : vec4<f32>;
var<private> nodeVar87 : vec2<f32>;
var<private> nodeVar88 : vec2<f32>;
var<private> nodeVar89 : vec4<f32>;
var<private> nodeVar90 : vec2<f32>;
var<private> nodeVar91 : vec4<f32>;
var<private> nodeVar92 : vec2<f32>;
var<private> nodeVar93 : vec4<f32>;
var<private> nodeVar94 : vec4<f32>;
var<private> nodeVar95 : vec2<f32>;
var<private> nodeVar96 : vec2<f32>;
var<private> nodeVar97 : vec4<f32>;
var<private> nodeVar98 : vec2<f32>;
var<private> nodeVar99 : vec4<f32>;
var<private> nodeVar100 : vec2<f32>;
var<private> nodeVar101 : vec4<f32>;
var<private> nodeVar102 : vec4<f32>;
var<private> nodeVar103 : vec2<f32>;
var<private> nodeVar104 : vec2<f32>;
var<private> nodeVar105 : vec4<f32>;
var<private> nodeVar106 : vec2<f32>;
var<private> nodeVar107 : vec4<f32>;
var<private> nodeVar108 : vec2<f32>;
var<private> nodeVar109 : vec4<f32>;
var<private> nodeVar110 : vec4<f32>;
var<private> nodeVar111 : f32;
var<private> nodeVar112 : f32;
var<private> nodeVar113 : vec2<f32>;
var<private> nodeVar114 : vec2<f32>;
var<private> nodeVar115 : vec2<f32>;
var<private> nodeVar116 : vec2<i32>;
var<private> nodeVar117 : vec4<f32>;
var<private> nodeVar118 : vec2<i32>;
var<private> nodeVar119 : vec4<f32>;
var<private> nodeVar120 : vec4<f32>;
var<private> nodeVar121 : vec4<f32>;
var<private> nodeVar122 : vec4<f32>;
var<private> nodeVar123 : vec2<f32>;
var<private> nodeVar124 : vec4<f32>;
var<private> nodeVar125 : vec2<f32>;
var<private> nodeVar126 : vec4<f32>;
var<private> nodeVar127 : vec4<f32>;
var<private> nodeVar128 : f32;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : vec2<f32>;
var<private> nodeVar132 : vec2<f32>;
var<private> nodeVar133 : vec4<f32>;
var<private> nodeVar134 : vec2<f32>;
var<private> nodeVar135 : vec4<f32>;
var<private> nodeVar136 : vec2<f32>;
var<private> nodeVar137 : vec4<f32>;
var<private> nodeVar138 : vec4<f32>;
var<private> nodeVar139 : vec2<f32>;
var<private> nodeVar140 : vec2<f32>;
var<private> nodeVar141 : vec4<f32>;
var<private> nodeVar142 : vec2<f32>;
var<private> nodeVar143 : vec4<f32>;
var<private> nodeVar144 : vec2<f32>;
var<private> nodeVar145 : vec4<f32>;
var<private> nodeVar146 : vec4<f32>;
var<private> nodeVar147 : f32;
var<private> nodeVar148 : vec2<f32>;
var<private> nodeVar149 : vec2<f32>;
var<private> nodeVar150 : vec4<f32>;
var<private> nodeVar151 : vec2<f32>;
var<private> nodeVar152 : vec4<f32>;
var<private> nodeVar153 : vec2<f32>;
var<private> nodeVar154 : vec4<f32>;
var<private> nodeVar155 : vec4<f32>;
var<private> nodeVar156 : vec2<f32>;
var<private> nodeVar157 : vec2<f32>;
var<private> nodeVar158 : vec4<f32>;
var<private> nodeVar159 : vec2<f32>;
var<private> nodeVar160 : vec4<f32>;
var<private> nodeVar161 : vec2<f32>;
var<private> nodeVar162 : vec4<f32>;
var<private> nodeVar163 : vec4<f32>;
var<private> nodeVar164 : vec2<f32>;
var<private> nodeVar165 : vec2<f32>;
var<private> nodeVar166 : vec4<f32>;
var<private> nodeVar167 : vec2<f32>;
var<private> nodeVar168 : vec4<f32>;
var<private> nodeVar169 : vec2<f32>;
var<private> nodeVar170 : vec4<f32>;
var<private> nodeVar171 : vec4<f32>;
var<private> nodeVar172 : vec2<f32>;
var<private> nodeVar173 : vec2<f32>;
var<private> nodeVar174 : vec4<f32>;
var<private> nodeVar175 : vec2<f32>;
var<private> nodeVar176 : vec4<f32>;
var<private> nodeVar177 : vec2<f32>;
var<private> nodeVar178 : vec4<f32>;
var<private> nodeVar179 : vec4<f32>;
var<private> nodeVar180 : f32;
var<private> nodeVar181 : f32;
var<private> nodeVar182 : vec2<f32>;
var<private> nodeVar183 : vec2<f32>;
var<private> nodeVar184 : vec2<f32>;
var<private> nodeVar185 : vec2<i32>;
var<private> nodeVar186 : vec4<f32>;
var<private> nodeVar187 : vec2<i32>;
var<private> nodeVar188 : vec4<f32>;
var<private> nodeVar189 : vec4<f32>;
var<private> nodeVar190 : vec4<f32>;
var<private> nodeVar191 : vec4<f32>;
var<private> nodeVar192 : vec2<f32>;
var<private> nodeVar193 : vec4<f32>;
var<private> nodeVar194 : vec2<f32>;
var<private> nodeVar195 : vec4<f32>;
var<private> nodeVar196 : vec4<f32>;
var<private> nodeVar197 : f32;
var<private> nodeVar198 : u32;
var<private> nodeVar199 : u32;
var<private> nodeVar200 : u32;
var<private> nodeVar201 : u32;
var<private> nodeVar202 : u32;
var<private> nodeVar203 : u32;
var<private> nodeVar204 : f32;
var<private> nodeVar205 : vec2<f32>;
var<private> nodeVar206 : vec2<f32>;
var<private> nodeVar207 : vec4<f32>;
var<private> nodeVar208 : f32;
var<private> nodeVar209 : vec2<f32>;
var<private> nodeVar210 : vec2<f32>;
var<private> nodeVar211 : vec2<f32>;
var<private> nodeVar212 : vec2<i32>;
var<private> nodeVar213 : vec4<f32>;
var<private> nodeVar214 : vec2<i32>;
var<private> nodeVar215 : vec4<f32>;
var<private> nodeVar216 : vec4<f32>;
var<private> nodeVar217 : vec4<f32>;
var<private> nodeVar218 : vec4<f32>;
var<private> nodeVar219 : vec2<f32>;
var<private> nodeVar220 : vec4<f32>;
var<private> nodeVar221 : vec2<f32>;
var<private> nodeVar222 : vec4<f32>;
var<private> nodeVar223 : vec4<f32>;
var<private> nodeVar224 : u32;
var<private> nodeVar225 : u32;
var<private> nodeVar226 : u32;
var<private> nodeVar227 : u32;
var<private> nodeVar228 : u32;
var<private> nodeVar229 : u32;
var<private> nodeVar230 : u32;
var<private> nodeVar231 : vec3<f32>;
var<private> nodeVar232 : f32;
var<private> nodeVar233 : f32;
var<private> nodeVar234 : vec3<f32>;
var<private> nodeVar235 : vec3<f32>;
var<private> nodeVar236 : f32;
var<private> nodeVar237 : vec2<f32>;
var<private> nodeVar238 : vec2<f32>;
var<private> nodeVar239 : vec2<f32>;
var<private> nodeVar240 : vec2<f32>;
var<private> nodeVar241 : vec2<i32>;
var<private> nodeVar242 : vec4<f32>;
var<private> nodeVar243 : vec2<i32>;
var<private> nodeVar244 : vec4<f32>;
var<private> nodeVar245 : vec4<f32>;
var<private> nodeVar246 : vec4<f32>;
var<private> nodeVar247 : vec4<f32>;
var<private> nodeVar248 : vec2<f32>;
var<private> nodeVar249 : vec4<f32>;
var<private> nodeVar250 : vec2<f32>;
var<private> nodeVar251 : vec4<f32>;
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
var<private> nodeVar271 : vec2<f32>;
var<private> nodeVar272 : vec2<f32>;
var<private> nodeVar273 : vec2<f32>;
var<private> nodeVar274 : vec2<i32>;
var<private> nodeVar275 : vec4<f32>;
var<private> nodeVar276 : vec2<i32>;
var<private> nodeVar277 : vec4<f32>;
var<private> nodeVar278 : vec4<f32>;
var<private> nodeVar279 : vec4<f32>;
var<private> nodeVar280 : vec4<f32>;
var<private> nodeVar281 : vec2<f32>;
var<private> nodeVar282 : vec4<f32>;
var<private> nodeVar283 : vec2<f32>;
var<private> nodeVar284 : vec4<f32>;
var<private> nodeVar285 : vec4<f32>;
var<private> nodeVar286 : f32;
var<private> nodeVar287 : vec2<f32>;
var<private> nodeVar288 : vec2<f32>;
var<private> nodeVar289 : vec2<f32>;
var<private> nodeVar290 : vec2<i32>;
var<private> nodeVar291 : vec4<f32>;
var<private> nodeVar292 : vec2<i32>;
var<private> nodeVar293 : vec4<f32>;
var<private> nodeVar294 : vec4<f32>;
var<private> nodeVar295 : vec4<f32>;
var<private> nodeVar296 : vec4<f32>;
var<private> nodeVar297 : vec2<f32>;
var<private> nodeVar298 : vec4<f32>;
var<private> nodeVar299 : vec2<f32>;
var<private> nodeVar300 : vec4<f32>;
var<private> nodeVar301 : vec4<f32>;
var<private> nodeVar302 : f32;
var<private> nodeVar303 : f32;
var<private> nodeVar304 : f32;
var<private> nodeVar305 : f32;
var<private> nodeVar306 : f32;
var<private> nodeVar307 : f32;
var<private> nodeVar308 : f32;
var<private> nodeVar309 : f32;
var<private> nodeVar310 : vec4<f32>;
var<private> nodeVar311 : vec2<f32>;
var<private> nodeVar312 : vec4<f32>;
var<private> nodeVar313 : vec4<f32>;
var<private> nodeVar314 : vec4<f32>;
var<private> nodeVar315 : vec4<f32>;
var<private> nodeVar316 : vec4<f32>;
var<private> nodeVar317 : vec3<f32>;

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

	if ( instanceIndex >= object.nodeUniform97 ) { return; }

	nodeVar1 = ( i32( instanceIndex ) < object.nodeUniform0 );

	if ( nodeVar1 ) {

		nodeVar0 = object.nodeUniform1;

	} else {


		if ( ( i32( instanceIndex ) < object.nodeUniform2 ) ) {

			nodeVar2 = object.nodeUniform3;

		} else {

			nodeVar2 = object.nodeUniform4;

		}

		nodeVar0 = nodeVar2;

	}


	if ( nodeVar1 ) {

		nodeVar3 = 0;

	} else {


		if ( ( i32( instanceIndex ) < object.nodeUniform2 ) ) {

			nodeVar4 = object.nodeUniform5;

		} else {

			nodeVar4 = object.nodeUniform6;

		}

		nodeVar3 = nodeVar4;

	}


	if ( nodeVar1 ) {

		nodeVar5 = i32( instanceIndex );

	} else {


		if ( ( i32( instanceIndex ) < object.nodeUniform2 ) ) {

			nodeVar6 = ( i32( instanceIndex ) - object.nodeUniform0 );

		} else {

			nodeVar6 = ( i32( instanceIndex ) - object.nodeUniform2 );

		}

		nodeVar5 = nodeVar6;

	}

	nodeVar7 = max( nodeVar0, 1 );
	nodeVar8 = ( nodeVar3 + ( nodeVar5 / nodeVar7 ) );

	if ( ( ( nodeVar0 > 0 ) && ( nodeVar8 < ( i32( object.nodeUniform7 ) * i32( object.nodeUniform7 ) ) ) ) ) {

		nodeVar9 = i32( ceil( ( ( sqrt( f32( ( nodeVar8 + 1 ) ) ) - 1.0 ) / 2.0 ) ) );
		nodeVar10 = ( ( nodeVar9 * 2 ) - 1 );

		if ( ( ( nodeVar9 > 0 ) && ( ( nodeVar10 * nodeVar10 ) > nodeVar8 ) ) ) {

			nodeVar9 = ( nodeVar9 - 1 );
			

		}

		nodeVar11 = ( ( nodeVar9 * 2 ) + 1 );

		if ( ( ( nodeVar11 * nodeVar11 ) <= nodeVar8 ) ) {

			nodeVar9 = ( nodeVar9 + 1 );
			

		}


		if ( ( nodeVar9 > 0 ) ) {

			nodeVar15 = ( ( nodeVar9 * 2 ) - 1 );
			nodeVar14 = ( nodeVar15 * nodeVar15 );

		} else {

			nodeVar14 = 0;

		}

		nodeVar16 = ( nodeVar8 - nodeVar14 );
		nodeVar17 = max( ( nodeVar9 * 2 ), 1 );
		nodeVar18 = ( nodeVar16 / nodeVar17 );

		if ( ( nodeVar18 == 0 ) ) {

			nodeVar13 = ( ( - nodeVar9 ) + ( nodeVar16 % nodeVar17 ) );

		} else {


			if ( ( nodeVar18 == 1 ) ) {

				nodeVar19 = nodeVar9;

			} else {


				if ( ( nodeVar18 == 2 ) ) {

					nodeVar20 = ( nodeVar9 - ( nodeVar16 % nodeVar17 ) );

				} else {

					nodeVar20 = ( - nodeVar9 );

				}

				nodeVar19 = nodeVar20;

			}

			nodeVar13 = nodeVar19;

		}

		nodeVar21 = ( i32( floor( ( object.nodeUniform9.x / object.nodeUniform10 ) ) ) + nodeVar13 );
		nodeVar22 = ( nodeVar21 + object.nodeUniform11 );

		if ( ( nodeVar18 == 0 ) ) {

			nodeVar23 = ( - nodeVar9 );

		} else {


			if ( ( nodeVar18 == 1 ) ) {

				nodeVar24 = ( ( - nodeVar9 ) + ( nodeVar16 % nodeVar17 ) );

			} else {


				if ( ( nodeVar18 == 2 ) ) {

					nodeVar25 = nodeVar9;

				} else {

					nodeVar25 = ( nodeVar9 - ( nodeVar16 % nodeVar17 ) );

				}

				nodeVar24 = nodeVar25;

			}

			nodeVar23 = nodeVar24;

		}

		nodeVar26 = ( i32( floor( ( object.nodeUniform9.y / object.nodeUniform10 ) ) ) + nodeVar23 );
		nodeVar27 = ( nodeVar26 + object.nodeUniform12 );
		nodeVar28 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
		nodeVar29 = ( nodeVar5 % nodeVar7 );
		nodeVar30 = ( ( ( ( nodeVar28 ^ ( nodeVar28 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 1 ) * 2246822519u ) );
		nodeVar31 = ( ( nodeVar30 ^ ( nodeVar30 >> 13u ) ) * 3266489917u );
		nodeVar32 = ( ( f32( nodeVar21 ) * object.nodeUniform10 ) + ( ( f32( ( nodeVar31 ^ ( nodeVar31 >> 16u ) ) ) / 4294967296.0 ) * object.nodeUniform10 ) );
		nodeVar33 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
		nodeVar34 = ( ( ( ( nodeVar33 ^ ( nodeVar33 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 2 ) * 2246822519u ) );
		nodeVar35 = ( ( nodeVar34 ^ ( nodeVar34 >> 13u ) ) * 3266489917u );
		nodeVar36 = ( ( f32( nodeVar26 ) * object.nodeUniform10 ) + ( ( f32( ( nodeVar35 ^ ( nodeVar35 >> 16u ) ) ) / 4294967296.0 ) * object.nodeUniform10 ) );
		nodeVar37 = vec2<f32>( object.nodeUniform13.x, object.nodeUniform13.z );
		nodeVar38 = ( vec2<f32>( nodeVar32, nodeVar36 ) + nodeVar37 );
		nodeVar39 = ( ( nodeVar38 - object.nodeUniform14 ) / object.nodeUniform15 );
		nodeVar41 = textureDimensions( nodeUniform16, u32( 0 ) );
		nodeVar40 = textureLoad( nodeUniform16, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform17 * vec3<f32>( clamp( ( ( nodeVar38 - object.nodeUniform14 ) / object.nodeUniform15 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar41 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar41 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );

		if ( ( ( ( ( ( ( object.nodeUniform8 > 0.5 ) && ( nodeVar39.x > 0.0 ) ) && ( nodeVar39.x < 1.0 ) ) && ( nodeVar39.y > 0.0 ) ) && ( nodeVar39.y < 1.0 ) ) && ( nodeVar40.x >= 0.0 ) ) ) {

			nodeVar42 = textureLoad( nodeUniform16, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform18 * vec3<f32>( clamp( ( ( nodeVar38 - object.nodeUniform14 ) / object.nodeUniform15 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar41 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar41 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
			nodeVar12 = ( nodeVar42.x - object.nodeUniform13.y );

		} else {

			nodeVar45 = ( vec2<f32>( nodeVar32, nodeVar36 ) + vec2<f32>( object.nodeUniform13.x, object.nodeUniform13.z ) );
			nodeVar46 = ( ( nodeVar45 / vec2<f32>( object.nodeUniform19 ) ) - object.nodeUniform20 );
			nodeVar47 = floor( nodeVar46 );
			nodeVar48 = ( nodeVar47 + object.nodeUniform20 );
			nodeVar49 = ( vec2<i32>( floor( ( nodeVar48 / vec2<f32>( f32( object.nodeUniform23 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar48 / vec2<f32>( f32( object.nodeUniform23 ) ) ) ) ).x ) / f32( object.nodeUniform24 ) ) ) ) ) * vec2<i32>( object.nodeUniform24 ) ) );
			nodeVar50 = textureLoad( nodeUniform22, nodeVar49, u32( 0u ) );
			nodeVar51 = ( vec2<i32>( floor( ( ( nodeVar48 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform23 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar48 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform23 ) ) ) ) ).x ) / f32( object.nodeUniform24 ) ) ) ) ) * vec2<i32>( object.nodeUniform24 ) ) );
			nodeVar52 = textureLoad( nodeUniform22, nodeVar51, u32( 0u ) );
			nodeVar53 = textureLoad( nodeUniform22, vec2<i32>( nodeVar51.x, nodeVar49.y ), u32( 0u ) );
			nodeVar54 = textureLoad( nodeUniform22, vec2<i32>( nodeVar49.x, nodeVar51.y ), u32( 0u ) );

			if ( ( ( ( ( ( ( ( ( nodeVar47.x >= 0.0 ) && ( nodeVar47.y >= 0.0 ) ) && ( nodeVar47.x < ( object.nodeUniform21 - 1.0 ) ) ) && ( nodeVar47.y < ( object.nodeUniform21 - 1.0 ) ) ) && ( nodeVar50.x > 0.5 ) ) && ( nodeVar52.x > 0.5 ) ) && ( nodeVar53.x > 0.5 ) ) && ( nodeVar54.x > 0.5 ) ) ) {

				nodeVar55 = textureLoad( nodeUniform25, vec2<i32>( vec2<i32>( ( nodeVar48 - ( floor( ( nodeVar48 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).x, vec2<i32>( ( nodeVar48 - ( floor( ( nodeVar48 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).y ), u32( 0u ) );
				nodeVar56 = ( nodeVar48 + vec2<f32>( 1.0 ) );
				nodeVar57 = textureLoad( nodeUniform25, vec2<i32>( vec2<i32>( ( nodeVar56 - ( floor( ( nodeVar56 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).x, vec2<i32>( ( nodeVar48 - ( floor( ( nodeVar48 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).y ), u32( 0u ) );
				nodeVar58 = fract( nodeVar46 );
				nodeVar59 = textureLoad( nodeUniform25, vec2<i32>( vec2<i32>( ( nodeVar48 - ( floor( ( nodeVar48 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).x, vec2<i32>( ( nodeVar56 - ( floor( ( nodeVar56 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).y ), u32( 0u ) );
				nodeVar60 = textureLoad( nodeUniform25, vec2<i32>( vec2<i32>( ( nodeVar56 - ( floor( ( nodeVar56 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).x, vec2<i32>( ( nodeVar56 - ( floor( ( nodeVar56 / vec2<f32>( object.nodeUniform21 ) ) ) * vec2<f32>( object.nodeUniform21 ) ) ) ).y ), u32( 0u ) );
				nodeVar44 = mix( mix( nodeVar55.x, nodeVar57.x, nodeVar58.x ), mix( nodeVar59.x, nodeVar60.x, nodeVar58.x ), nodeVar58.y );

			} else {

				nodeVar44 = -1000000.0;

			}


			if ( ( nodeVar44 > -500000.0 ) ) {


				if ( ( object.nodeUniform26 > 0.5 ) ) {

					nodeVar62 = ( nodeVar45 / vec2<f32>( object.nodeUniform28 ) );
					nodeVar63 = clamp( floor( nodeVar62 ), object.nodeUniform29, ( ( object.nodeUniform29 + vec2<f32>( object.nodeUniform30 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar64 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar65 = ( nodeVar63 + vec2<f32>( 1.0 ) );
					nodeVar66 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar65 - ( floor( ( nodeVar65 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar67 = clamp( ( nodeVar62 - nodeVar63 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar68 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar63 - ( floor( ( nodeVar63 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar65 - ( floor( ( nodeVar65 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar69 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar65 - ( floor( ( nodeVar65 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar65 - ( floor( ( nodeVar65 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar70 = ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) );
					nodeVar71 = clamp( floor( nodeVar70 ), object.nodeUniform33, ( ( object.nodeUniform33 + vec2<f32>( object.nodeUniform34 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar72 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar73 = ( nodeVar71 + vec2<f32>( 1.0 ) );
					nodeVar74 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar73 - ( floor( ( nodeVar73 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar75 = clamp( ( nodeVar70 - nodeVar71 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar76 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar71 - ( floor( ( nodeVar71 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar73 - ( floor( ( nodeVar73 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar77 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar73 - ( floor( ( nodeVar73 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar73 - ( floor( ( nodeVar73 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar78 = mix( mix( mix( nodeVar64.x, nodeVar66.x, nodeVar67.x ), mix( nodeVar68.x, nodeVar69.x, nodeVar67.x ), nodeVar67.y ), mix( mix( nodeVar72.x, nodeVar74.x, nodeVar75.x ), mix( nodeVar76.x, nodeVar77.x, nodeVar75.x ), nodeVar75.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform35.x ) ), abs( ( nodeVar45.y - object.nodeUniform35.y ) ) ) / object.nodeUniform36 ) ) );

					if ( ( max( abs( ( nodeVar45.x - object.nodeUniform37.x ) ), abs( ( nodeVar45.y - object.nodeUniform37.y ) ) ) < object.nodeUniform38 ) ) {

						nodeVar79 = ( nodeVar45 / vec2<f32>( object.nodeUniform40 ) );
						nodeVar80 = clamp( floor( nodeVar79 ), object.nodeUniform41, ( ( object.nodeUniform41 + vec2<f32>( object.nodeUniform42 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar81 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar82 = ( nodeVar80 + vec2<f32>( 1.0 ) );
						nodeVar83 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar82 - ( floor( ( nodeVar82 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar84 = clamp( ( nodeVar79 - nodeVar80 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar85 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar80 - ( floor( ( nodeVar80 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar82 - ( floor( ( nodeVar82 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar86 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar82 - ( floor( ( nodeVar82 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar82 - ( floor( ( nodeVar82 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar87 = ( nodeVar45 / vec2<f32>( object.nodeUniform28 ) );
						nodeVar88 = clamp( floor( nodeVar87 ), object.nodeUniform29, ( ( object.nodeUniform29 + vec2<f32>( object.nodeUniform30 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar89 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar90 = ( nodeVar88 + vec2<f32>( 1.0 ) );
						nodeVar91 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar90 - ( floor( ( nodeVar90 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar92 = clamp( ( nodeVar87 - nodeVar88 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar93 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar88 - ( floor( ( nodeVar88 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar90 - ( floor( ( nodeVar90 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar94 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar90 - ( floor( ( nodeVar90 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar90 - ( floor( ( nodeVar90 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar78 = mix( mix( mix( nodeVar81.x, nodeVar83.x, nodeVar84.x ), mix( nodeVar85.x, nodeVar86.x, nodeVar84.x ), nodeVar84.y ), mix( mix( nodeVar89.x, nodeVar91.x, nodeVar92.x ), mix( nodeVar93.x, nodeVar94.x, nodeVar92.x ), nodeVar92.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform37.x ) ), abs( ( nodeVar45.y - object.nodeUniform37.y ) ) ) / object.nodeUniform38 ) ) );
						

					}


					if ( ( max( abs( ( nodeVar45.x - object.nodeUniform43.x ) ), abs( ( nodeVar45.y - object.nodeUniform43.y ) ) ) < object.nodeUniform44 ) ) {

						nodeVar95 = ( nodeVar45 / vec2<f32>( object.nodeUniform46 ) );
						nodeVar96 = clamp( floor( nodeVar95 ), object.nodeUniform47, ( ( object.nodeUniform47 + vec2<f32>( object.nodeUniform48 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar97 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar96 - ( floor( ( nodeVar96 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar96 - ( floor( ( nodeVar96 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar98 = ( nodeVar96 + vec2<f32>( 1.0 ) );
						nodeVar99 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar98 - ( floor( ( nodeVar98 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar96 - ( floor( ( nodeVar96 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar100 = clamp( ( nodeVar95 - nodeVar96 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar101 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar96 - ( floor( ( nodeVar96 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar98 - ( floor( ( nodeVar98 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar102 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar98 - ( floor( ( nodeVar98 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar98 - ( floor( ( nodeVar98 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar103 = ( nodeVar45 / vec2<f32>( object.nodeUniform40 ) );
						nodeVar104 = clamp( floor( nodeVar103 ), object.nodeUniform41, ( ( object.nodeUniform41 + vec2<f32>( object.nodeUniform42 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar105 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar104 - ( floor( ( nodeVar104 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar104 - ( floor( ( nodeVar104 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar106 = ( nodeVar104 + vec2<f32>( 1.0 ) );
						nodeVar107 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar104 - ( floor( ( nodeVar104 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar108 = clamp( ( nodeVar103 - nodeVar104 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar109 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar104 - ( floor( ( nodeVar104 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar110 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar106 - ( floor( ( nodeVar106 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar78 = mix( mix( mix( nodeVar97.x, nodeVar99.x, nodeVar100.x ), mix( nodeVar101.x, nodeVar102.x, nodeVar100.x ), nodeVar100.y ), mix( mix( nodeVar105.x, nodeVar107.x, nodeVar108.x ), mix( nodeVar109.x, nodeVar110.x, nodeVar108.x ), nodeVar108.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform43.x ) ), abs( ( nodeVar45.y - object.nodeUniform43.y ) ) ) / object.nodeUniform44 ) ) );
						

					}


					if ( ( ( ( ( nodeVar45.x > object.nodeUniform49.x ) && ( nodeVar45.x < object.nodeUniform50.x ) ) && ( nodeVar45.y > object.nodeUniform49.y ) ) && ( nodeVar45.y < object.nodeUniform50.y ) ) ) {

						nodeVar111 = 0.0;

					} else {

						nodeVar111 = -0.25;

					}

					nodeVar61 = ( nodeVar78 + nodeVar111 );

				} else {

					nodeVar113 = ( ( nodeVar45 / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
					nodeVar114 = floor( nodeVar113 );
					nodeVar115 = ( nodeVar114 + object.nodeUniform52 );
					nodeVar116 = ( vec2<i32>( floor( ( nodeVar115 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar115 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
					nodeVar117 = textureLoad( nodeUniform54, nodeVar116, u32( 0u ) );
					nodeVar118 = ( vec2<i32>( floor( ( ( nodeVar115 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar115 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
					nodeVar119 = textureLoad( nodeUniform54, nodeVar118, u32( 0u ) );
					nodeVar120 = textureLoad( nodeUniform54, vec2<i32>( nodeVar118.x, nodeVar116.y ), u32( 0u ) );
					nodeVar121 = textureLoad( nodeUniform54, vec2<i32>( nodeVar116.x, nodeVar118.y ), u32( 0u ) );

					if ( ( ( ( ( ( ( ( ( nodeVar114.x >= 0.0 ) && ( nodeVar114.y >= 0.0 ) ) && ( nodeVar114.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar114.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar117.x > 0.5 ) ) && ( nodeVar119.x > 0.5 ) ) && ( nodeVar120.x > 0.5 ) ) && ( nodeVar121.x > 0.5 ) ) ) {

						nodeVar122 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar115 - ( floor( ( nodeVar115 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar115 - ( floor( ( nodeVar115 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar123 = ( nodeVar115 + vec2<f32>( 1.0 ) );
						nodeVar124 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar123 - ( floor( ( nodeVar123 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar115 - ( floor( ( nodeVar115 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar125 = fract( nodeVar113 );
						nodeVar126 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar115 - ( floor( ( nodeVar115 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar123 - ( floor( ( nodeVar123 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar127 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar123 - ( floor( ( nodeVar123 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar123 - ( floor( ( nodeVar123 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar112 = mix( mix( nodeVar122.x, nodeVar124.x, nodeVar125.x ), mix( nodeVar126.x, nodeVar127.x, nodeVar125.x ), nodeVar125.y );

					} else {

						nodeVar112 = -1000000.0;

					}

					nodeVar61 = nodeVar112;

				}


				if ( ( nodeVar61 > -500000.0 ) ) {

					nodeVar128 = clamp( ( ( length( ( vec2<f32>( nodeVar32, nodeVar36 ) - object.nodeUniform58 ) ) - object.nodeUniform59 ) / object.nodeUniform60 ), 0.0, 1.0 );

				} else {

					nodeVar128 = 0.0;

				}

				nodeVar43 = mix( nodeVar44, nodeVar61, nodeVar128 );

			} else {


				if ( ( object.nodeUniform26 > 0.5 ) ) {

					nodeVar131 = ( nodeVar45 / vec2<f32>( object.nodeUniform28 ) );
					nodeVar132 = clamp( floor( nodeVar131 ), object.nodeUniform29, ( ( object.nodeUniform29 + vec2<f32>( object.nodeUniform30 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar133 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar134 = ( nodeVar132 + vec2<f32>( 1.0 ) );
					nodeVar135 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar134 - ( floor( ( nodeVar134 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar136 = clamp( ( nodeVar131 - nodeVar132 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar137 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar132 - ( floor( ( nodeVar132 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar134 - ( floor( ( nodeVar134 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar138 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar134 - ( floor( ( nodeVar134 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar134 - ( floor( ( nodeVar134 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
					nodeVar139 = ( nodeVar45 / vec2<f32>( object.nodeUniform32 ) );
					nodeVar140 = clamp( floor( nodeVar139 ), object.nodeUniform33, ( ( object.nodeUniform33 + vec2<f32>( object.nodeUniform34 ) ) - vec2<f32>( 2.0 ) ) );
					nodeVar141 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar142 = ( nodeVar140 + vec2<f32>( 1.0 ) );
					nodeVar143 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar142 - ( floor( ( nodeVar142 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar144 = clamp( ( nodeVar139 - nodeVar140 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
					nodeVar145 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar140 - ( floor( ( nodeVar140 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar142 - ( floor( ( nodeVar142 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar146 = textureLoad( nodeUniform31, vec2<i32>( vec2<i32>( ( nodeVar142 - ( floor( ( nodeVar142 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).x, vec2<i32>( ( nodeVar142 - ( floor( ( nodeVar142 / vec2<f32>( object.nodeUniform34 ) ) ) * vec2<f32>( object.nodeUniform34 ) ) ) ).y ), u32( 0u ) );
					nodeVar147 = mix( mix( mix( nodeVar133.x, nodeVar135.x, nodeVar136.x ), mix( nodeVar137.x, nodeVar138.x, nodeVar136.x ), nodeVar136.y ), mix( mix( nodeVar141.x, nodeVar143.x, nodeVar144.x ), mix( nodeVar145.x, nodeVar146.x, nodeVar144.x ), nodeVar144.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform35.x ) ), abs( ( nodeVar45.y - object.nodeUniform35.y ) ) ) / object.nodeUniform36 ) ) );

					if ( ( max( abs( ( nodeVar45.x - object.nodeUniform37.x ) ), abs( ( nodeVar45.y - object.nodeUniform37.y ) ) ) < object.nodeUniform38 ) ) {

						nodeVar148 = ( nodeVar45 / vec2<f32>( object.nodeUniform40 ) );
						nodeVar149 = clamp( floor( nodeVar148 ), object.nodeUniform41, ( ( object.nodeUniform41 + vec2<f32>( object.nodeUniform42 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar150 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar151 = ( nodeVar149 + vec2<f32>( 1.0 ) );
						nodeVar152 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar151 - ( floor( ( nodeVar151 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar153 = clamp( ( nodeVar148 - nodeVar149 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar154 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar149 - ( floor( ( nodeVar149 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar151 - ( floor( ( nodeVar151 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar155 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar151 - ( floor( ( nodeVar151 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar151 - ( floor( ( nodeVar151 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar156 = ( nodeVar45 / vec2<f32>( object.nodeUniform28 ) );
						nodeVar157 = clamp( floor( nodeVar156 ), object.nodeUniform29, ( ( object.nodeUniform29 + vec2<f32>( object.nodeUniform30 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar158 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar159 = ( nodeVar157 + vec2<f32>( 1.0 ) );
						nodeVar160 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar159 - ( floor( ( nodeVar159 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar161 = clamp( ( nodeVar156 - nodeVar157 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar162 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar157 - ( floor( ( nodeVar157 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar159 - ( floor( ( nodeVar159 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar163 = textureLoad( nodeUniform27, vec2<i32>( vec2<i32>( ( nodeVar159 - ( floor( ( nodeVar159 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).x, vec2<i32>( ( nodeVar159 - ( floor( ( nodeVar159 / vec2<f32>( object.nodeUniform30 ) ) ) * vec2<f32>( object.nodeUniform30 ) ) ) ).y ), u32( 0u ) );
						nodeVar147 = mix( mix( mix( nodeVar150.x, nodeVar152.x, nodeVar153.x ), mix( nodeVar154.x, nodeVar155.x, nodeVar153.x ), nodeVar153.y ), mix( mix( nodeVar158.x, nodeVar160.x, nodeVar161.x ), mix( nodeVar162.x, nodeVar163.x, nodeVar161.x ), nodeVar161.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform37.x ) ), abs( ( nodeVar45.y - object.nodeUniform37.y ) ) ) / object.nodeUniform38 ) ) );
						

					}


					if ( ( max( abs( ( nodeVar45.x - object.nodeUniform43.x ) ), abs( ( nodeVar45.y - object.nodeUniform43.y ) ) ) < object.nodeUniform44 ) ) {

						nodeVar164 = ( nodeVar45 / vec2<f32>( object.nodeUniform46 ) );
						nodeVar165 = clamp( floor( nodeVar164 ), object.nodeUniform47, ( ( object.nodeUniform47 + vec2<f32>( object.nodeUniform48 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar166 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar165 - ( floor( ( nodeVar165 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar165 - ( floor( ( nodeVar165 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar167 = ( nodeVar165 + vec2<f32>( 1.0 ) );
						nodeVar168 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar167 - ( floor( ( nodeVar167 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar165 - ( floor( ( nodeVar165 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar169 = clamp( ( nodeVar164 - nodeVar165 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar170 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar165 - ( floor( ( nodeVar165 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar167 - ( floor( ( nodeVar167 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar171 = textureLoad( nodeUniform45, vec2<i32>( vec2<i32>( ( nodeVar167 - ( floor( ( nodeVar167 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).x, vec2<i32>( ( nodeVar167 - ( floor( ( nodeVar167 / vec2<f32>( object.nodeUniform48 ) ) ) * vec2<f32>( object.nodeUniform48 ) ) ) ).y ), u32( 0u ) );
						nodeVar172 = ( nodeVar45 / vec2<f32>( object.nodeUniform40 ) );
						nodeVar173 = clamp( floor( nodeVar172 ), object.nodeUniform41, ( ( object.nodeUniform41 + vec2<f32>( object.nodeUniform42 ) ) - vec2<f32>( 2.0 ) ) );
						nodeVar174 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar173 - ( floor( ( nodeVar173 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar173 - ( floor( ( nodeVar173 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar175 = ( nodeVar173 + vec2<f32>( 1.0 ) );
						nodeVar176 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar175 - ( floor( ( nodeVar175 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar173 - ( floor( ( nodeVar173 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar177 = clamp( ( nodeVar172 - nodeVar173 ), vec2<f32>( 0.0, 0.0 ), vec2<f32>( 1.0, 1.0 ) );
						nodeVar178 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar173 - ( floor( ( nodeVar173 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar175 - ( floor( ( nodeVar175 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar179 = textureLoad( nodeUniform39, vec2<i32>( vec2<i32>( ( nodeVar175 - ( floor( ( nodeVar175 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).x, vec2<i32>( ( nodeVar175 - ( floor( ( nodeVar175 / vec2<f32>( object.nodeUniform42 ) ) ) * vec2<f32>( object.nodeUniform42 ) ) ) ).y ), u32( 0u ) );
						nodeVar147 = mix( mix( mix( nodeVar166.x, nodeVar168.x, nodeVar169.x ), mix( nodeVar170.x, nodeVar171.x, nodeVar169.x ), nodeVar169.y ), mix( mix( nodeVar174.x, nodeVar176.x, nodeVar177.x ), mix( nodeVar178.x, nodeVar179.x, nodeVar177.x ), nodeVar177.y ), smoothstep( 0.7, 0.95, ( max( abs( ( nodeVar45.x - object.nodeUniform43.x ) ), abs( ( nodeVar45.y - object.nodeUniform43.y ) ) ) / object.nodeUniform44 ) ) );
						

					}


					if ( ( ( ( ( nodeVar45.x > object.nodeUniform49.x ) && ( nodeVar45.x < object.nodeUniform50.x ) ) && ( nodeVar45.y > object.nodeUniform49.y ) ) && ( nodeVar45.y < object.nodeUniform50.y ) ) ) {

						nodeVar180 = 0.0;

					} else {

						nodeVar180 = -0.25;

					}

					nodeVar130 = ( nodeVar147 + nodeVar180 );

				} else {

					nodeVar182 = ( ( nodeVar45 / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
					nodeVar183 = floor( nodeVar182 );
					nodeVar184 = ( nodeVar183 + object.nodeUniform52 );
					nodeVar185 = ( vec2<i32>( floor( ( nodeVar184 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar184 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
					nodeVar186 = textureLoad( nodeUniform54, nodeVar185, u32( 0u ) );
					nodeVar187 = ( vec2<i32>( floor( ( ( nodeVar184 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar184 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
					nodeVar188 = textureLoad( nodeUniform54, nodeVar187, u32( 0u ) );
					nodeVar189 = textureLoad( nodeUniform54, vec2<i32>( nodeVar187.x, nodeVar185.y ), u32( 0u ) );
					nodeVar190 = textureLoad( nodeUniform54, vec2<i32>( nodeVar185.x, nodeVar187.y ), u32( 0u ) );

					if ( ( ( ( ( ( ( ( ( nodeVar183.x >= 0.0 ) && ( nodeVar183.y >= 0.0 ) ) && ( nodeVar183.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar183.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar186.x > 0.5 ) ) && ( nodeVar188.x > 0.5 ) ) && ( nodeVar189.x > 0.5 ) ) && ( nodeVar190.x > 0.5 ) ) ) {

						nodeVar191 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar184 - ( floor( ( nodeVar184 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar184 - ( floor( ( nodeVar184 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar192 = ( nodeVar184 + vec2<f32>( 1.0 ) );
						nodeVar193 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar192 - ( floor( ( nodeVar192 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar184 - ( floor( ( nodeVar184 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar194 = fract( nodeVar182 );
						nodeVar195 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar184 - ( floor( ( nodeVar184 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar192 - ( floor( ( nodeVar192 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar196 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar192 - ( floor( ( nodeVar192 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar192 - ( floor( ( nodeVar192 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
						nodeVar181 = mix( mix( nodeVar191.x, nodeVar193.x, nodeVar194.x ), mix( nodeVar195.x, nodeVar196.x, nodeVar194.x ), nodeVar194.y );

					} else {

						nodeVar181 = -1000000.0;

					}

					nodeVar130 = nodeVar181;

				}


				if ( ( nodeVar130 > -500000.0 ) ) {

					nodeVar129 = nodeVar130;

				} else {

					nodeVar129 = -100000.0;

				}

				nodeVar43 = nodeVar129;

			}

			nodeVar12 = ( nodeVar43 - object.nodeUniform13.y );

		}

		nodeVar197 = length( vec2<f32>( ( nodeVar32 - object.nodeUniform9.x ), ( nodeVar36 - object.nodeUniform9.y ) ) );
		nodeVar198 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
		nodeVar199 = ( ( ( ( nodeVar198 ^ ( nodeVar198 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 7 ) * 2246822519u ) );
		nodeVar200 = ( ( nodeVar199 ^ ( nodeVar199 >> 13u ) ) * 3266489917u );
		nodeVar201 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
		nodeVar202 = ( ( ( ( nodeVar201 ^ ( nodeVar201 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 8 ) * 2246822519u ) );
		nodeVar203 = ( ( nodeVar202 ^ ( nodeVar202 >> 13u ) ) * 3266489917u );
		nodeVar205 = ( vec2<f32>( nodeVar32, nodeVar36 ) + nodeVar37 );
		nodeVar206 = ( ( nodeVar205 - object.nodeUniform14 ) / object.nodeUniform15 );
		nodeVar207 = textureLoad( nodeUniform16, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( ( object.nodeUniform73 * vec3<f32>( clamp( ( ( nodeVar205 - object.nodeUniform14 ) / object.nodeUniform15 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) ), 1.0 ) ).xy ) * vec2<f32>( nodeVar41 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar41 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );

		if ( ( ( ( ( ( ( object.nodeUniform8 > 0.5 ) && ( nodeVar206.x > 0.0 ) ) && ( nodeVar206.x < 1.0 ) ) && ( nodeVar206.y > 0.0 ) ) && ( nodeVar206.y < 1.0 ) ) && ( nodeVar207.x >= 0.0 ) ) ) {

			nodeVar204 = nodeVar207.x;

		} else {

			nodeVar209 = ( ( ( vec2<f32>( nodeVar32, nodeVar36 ) + vec2<f32>( object.nodeUniform13.x, object.nodeUniform13.z ) ) / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
			nodeVar210 = floor( nodeVar209 );
			nodeVar211 = ( nodeVar210 + object.nodeUniform52 );
			nodeVar212 = ( vec2<i32>( floor( ( nodeVar211 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar211 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
			nodeVar213 = textureLoad( nodeUniform54, nodeVar212, u32( 0u ) );
			nodeVar214 = ( vec2<i32>( floor( ( ( nodeVar211 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar211 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
			nodeVar215 = textureLoad( nodeUniform54, nodeVar214, u32( 0u ) );
			nodeVar216 = textureLoad( nodeUniform54, vec2<i32>( nodeVar214.x, nodeVar212.y ), u32( 0u ) );
			nodeVar217 = textureLoad( nodeUniform54, vec2<i32>( nodeVar212.x, nodeVar214.y ), u32( 0u ) );

			if ( ( ( ( ( ( ( ( ( nodeVar210.x >= 0.0 ) && ( nodeVar210.y >= 0.0 ) ) && ( nodeVar210.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar210.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar213.x > 0.5 ) ) && ( nodeVar215.x > 0.5 ) ) && ( nodeVar216.x > 0.5 ) ) && ( nodeVar217.x > 0.5 ) ) ) {

				nodeVar218 = textureLoad( nodeUniform75, vec2<i32>( vec2<i32>( ( nodeVar211 - ( floor( ( nodeVar211 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar211 - ( floor( ( nodeVar211 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
				nodeVar219 = ( nodeVar211 + vec2<f32>( 1.0 ) );
				nodeVar220 = textureLoad( nodeUniform75, vec2<i32>( vec2<i32>( ( nodeVar219 - ( floor( ( nodeVar219 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar211 - ( floor( ( nodeVar211 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
				nodeVar221 = fract( nodeVar209 );
				nodeVar222 = textureLoad( nodeUniform75, vec2<i32>( vec2<i32>( ( nodeVar211 - ( floor( ( nodeVar211 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar219 - ( floor( ( nodeVar219 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
				nodeVar223 = textureLoad( nodeUniform75, vec2<i32>( vec2<i32>( ( nodeVar219 - ( floor( ( nodeVar219 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar219 - ( floor( ( nodeVar219 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
				nodeVar208 = mix( mix( ( nodeVar218.x * 255.0 ), ( nodeVar220.x * 255.0 ), nodeVar221.x ), mix( ( nodeVar222.x * 255.0 ), ( nodeVar223.x * 255.0 ), nodeVar221.x ), nodeVar221.y );

			} else {

				nodeVar208 = 0.0;

			}

			nodeVar204 = clamp( max( ( ( 1.0 - object.nodeUniform74 ) + ( clamp( ( nodeVar208 / 255.0 ), 0.0, 1.0 ) * object.nodeUniform74 ) ), object.nodeUniform76 ), 0.0, 1.0 );

		}


		if ( ( ( ( ( ( ( ( ( ( ( nodeVar12 > object.nodeUniform61 ) && ( nodeVar32 >= object.nodeUniform62 ) ) && ( nodeVar32 <= object.nodeUniform63 ) ) && ( nodeVar36 >= object.nodeUniform64 ) ) && ( nodeVar36 <= object.nodeUniform65 ) ) && ( nodeVar197 < object.nodeUniform66 ) ) && ( ( nodeVar197 < object.nodeUniform67 ) || ( dot( ( vec2<f32>( ( nodeVar32 - object.nodeUniform9.x ), ( nodeVar36 - object.nodeUniform9.y ) ) / vec2<f32>( max( nodeVar197, 0.001 ) ) ), object.nodeUniform68 ) > object.nodeUniform69 ) ) ) && ( 1.0 > 0.0 ) ) && ( ( f32( ( nodeVar200 ^ ( nodeVar200 >> 16u ) ) ) / 4294967296.0 ) > pow( clamp( ( ( nodeVar197 - object.nodeUniform70 ) / max( ( object.nodeUniform71 - object.nodeUniform70 ), 0.001 ) ), 0.0, 1.0 ), object.nodeUniform72 ) ) ) && ( ( f32( ( nodeVar203 ^ ( nodeVar203 >> 16u ) ) ) / 4294967296.0 ) < nodeVar204 ) ) ) {

			let nodeConst0 = atomicAdd( &NodeBuffer_1266.value[ 0u ], 1u );

			if ( ( ( nodeConst0 < object.nodeUniform78 ) && ( ( object.nodeUniform79 == 0u ) || ( nodeConst0 < object.nodeUniform79 ) ) ) ) {

				nodeVar224 = ( nodeConst0 * 2u );
				nodeVar225 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
				nodeVar226 = ( ( ( ( nodeVar225 ^ ( nodeVar225 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 5 ) * 2246822519u ) );
				nodeVar227 = ( ( nodeVar226 ^ ( nodeVar226 >> 13u ) ) * 3266489917u );
				NodeBuffer_1265.value[ nodeVar224 ] = vec4<f32>( nodeVar32, nodeVar12, nodeVar36, ( 0.8 + ( ( f32( ( nodeVar227 ^ ( nodeVar227 >> 16u ) ) ) / 4294967296.0 ) * 0.6 ) ) );
				nodeVar228 = ( ( bitcast<u32>( nodeVar22 ) * 1597334677u ) ^ ( bitcast<u32>( nodeVar27 ) * 3812015801u ) );
				nodeVar229 = ( ( ( ( nodeVar228 ^ ( nodeVar228 >> 15u ) ) * 2246822519u ) ^ ( ( bitcast<u32>( nodeVar29 ) + 1u ) * 2654435761u ) ) ^ ( bitcast<u32>( 3 ) * 2246822519u ) );
				nodeVar230 = ( ( nodeVar229 ^ ( nodeVar229 >> 13u ) ) * 3266489917u );
				nodeVar232 = ( nodeVar12 + object.nodeUniform13.y );
				nodeVar233 = ( nodeVar232 - object.nodeUniform81 );

				if ( ( nodeVar233 < 0.0 ) ) {

					nodeVar231 = mix( vec3<f32>( 0.16, 0.32, 0.42 ), vec3<f32>( 0.72, 0.66, 0.46 ), clamp( ( 1.0 + ( nodeVar233 / 6.0 ) ), 0.0, 1.0 ) );

				} else {


					if ( ( nodeVar233 < 2.0 ) ) {

						nodeVar234 = mix( vec3<f32>( 0.72, 0.66, 0.46 ), vec3<f32>( 0.3, 0.48, 0.22 ), clamp( ( nodeVar233 / 2.0 ), 0.0, 1.0 ) );

					} else {


						if ( ( nodeVar233 < 60.0 ) ) {

							nodeVar235 = mix( vec3<f32>( 0.3, 0.48, 0.22 ), vec3<f32>( 0.46, 0.44, 0.28 ), clamp( ( ( nodeVar233 - 20.0 ) / 40.0 ), 0.0, 1.0 ) );

						} else {

							nodeVar235 = mix( vec3<f32>( 0.46, 0.44, 0.28 ), vec3<f32>( 0.92, 0.93, 0.95 ), clamp( ( ( nodeVar233 - 60.0 ) / 40.0 ), 0.0, 1.0 ) );

						}

						nodeVar234 = nodeVar235;

					}

					nodeVar231 = nodeVar234;

				}

				nodeVar237 = ( vec2<f32>( nodeVar32, nodeVar36 ) + vec2<f32>( object.nodeUniform13.x, object.nodeUniform13.z ) );
				nodeVar238 = ( ( vec2<f32>( ( nodeVar237.x + 8.0 ), nodeVar237.y ) / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
				nodeVar239 = floor( nodeVar238 );
				nodeVar240 = ( nodeVar239 + object.nodeUniform52 );
				nodeVar241 = ( vec2<i32>( floor( ( nodeVar240 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar240 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar242 = textureLoad( nodeUniform54, nodeVar241, u32( 0u ) );
				nodeVar243 = ( vec2<i32>( floor( ( ( nodeVar240 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar240 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar244 = textureLoad( nodeUniform54, nodeVar243, u32( 0u ) );
				nodeVar245 = textureLoad( nodeUniform54, vec2<i32>( nodeVar243.x, nodeVar241.y ), u32( 0u ) );
				nodeVar246 = textureLoad( nodeUniform54, vec2<i32>( nodeVar241.x, nodeVar243.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar239.x >= 0.0 ) && ( nodeVar239.y >= 0.0 ) ) && ( nodeVar239.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar239.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar242.x > 0.5 ) ) && ( nodeVar244.x > 0.5 ) ) && ( nodeVar245.x > 0.5 ) ) && ( nodeVar246.x > 0.5 ) ) ) {

					nodeVar247 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar240 - ( floor( ( nodeVar240 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar240 - ( floor( ( nodeVar240 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar248 = ( nodeVar240 + vec2<f32>( 1.0 ) );
					nodeVar249 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar248 - ( floor( ( nodeVar248 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar240 - ( floor( ( nodeVar240 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar250 = fract( nodeVar238 );
					nodeVar251 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar240 - ( floor( ( nodeVar240 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar248 - ( floor( ( nodeVar248 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar252 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar248 - ( floor( ( nodeVar248 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar248 - ( floor( ( nodeVar248 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar236 = mix( mix( nodeVar247.x, nodeVar249.x, nodeVar250.x ), mix( nodeVar251.x, nodeVar252.x, nodeVar250.x ), nodeVar250.y );

				} else {

					nodeVar236 = nodeVar232;

				}

				nodeVar254 = ( ( vec2<f32>( ( nodeVar237.x - 8.0 ), nodeVar237.y ) / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
				nodeVar255 = floor( nodeVar254 );
				nodeVar256 = ( nodeVar255 + object.nodeUniform52 );
				nodeVar257 = ( vec2<i32>( floor( ( nodeVar256 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar256 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar258 = textureLoad( nodeUniform54, nodeVar257, u32( 0u ) );
				nodeVar259 = ( vec2<i32>( floor( ( ( nodeVar256 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar256 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar260 = textureLoad( nodeUniform54, nodeVar259, u32( 0u ) );
				nodeVar261 = textureLoad( nodeUniform54, vec2<i32>( nodeVar259.x, nodeVar257.y ), u32( 0u ) );
				nodeVar262 = textureLoad( nodeUniform54, vec2<i32>( nodeVar257.x, nodeVar259.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar255.x >= 0.0 ) && ( nodeVar255.y >= 0.0 ) ) && ( nodeVar255.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar255.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar258.x > 0.5 ) ) && ( nodeVar260.x > 0.5 ) ) && ( nodeVar261.x > 0.5 ) ) && ( nodeVar262.x > 0.5 ) ) ) {

					nodeVar263 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar264 = ( nodeVar256 + vec2<f32>( 1.0 ) );
					nodeVar265 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar266 = fract( nodeVar254 );
					nodeVar267 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar256 - ( floor( ( nodeVar256 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar268 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar264 - ( floor( ( nodeVar264 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar253 = mix( mix( nodeVar263.x, nodeVar265.x, nodeVar266.x ), mix( nodeVar267.x, nodeVar268.x, nodeVar266.x ), nodeVar266.y );

				} else {

					nodeVar253 = nodeVar232;

				}

				nodeVar269 = ( ( nodeVar236 - nodeVar253 ) / ( 8.0 * 2.0 ) );
				nodeVar271 = ( ( vec2<f32>( nodeVar237.x, ( nodeVar237.y + 8.0 ) ) / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
				nodeVar272 = floor( nodeVar271 );
				nodeVar273 = ( nodeVar272 + object.nodeUniform52 );
				nodeVar274 = ( vec2<i32>( floor( ( nodeVar273 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar273 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar275 = textureLoad( nodeUniform54, nodeVar274, u32( 0u ) );
				nodeVar276 = ( vec2<i32>( floor( ( ( nodeVar273 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar273 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar277 = textureLoad( nodeUniform54, nodeVar276, u32( 0u ) );
				nodeVar278 = textureLoad( nodeUniform54, vec2<i32>( nodeVar276.x, nodeVar274.y ), u32( 0u ) );
				nodeVar279 = textureLoad( nodeUniform54, vec2<i32>( nodeVar274.x, nodeVar276.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar272.x >= 0.0 ) && ( nodeVar272.y >= 0.0 ) ) && ( nodeVar272.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar272.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar275.x > 0.5 ) ) && ( nodeVar277.x > 0.5 ) ) && ( nodeVar278.x > 0.5 ) ) && ( nodeVar279.x > 0.5 ) ) ) {

					nodeVar280 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar273 - ( floor( ( nodeVar273 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar273 - ( floor( ( nodeVar273 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar281 = ( nodeVar273 + vec2<f32>( 1.0 ) );
					nodeVar282 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar281 - ( floor( ( nodeVar281 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar273 - ( floor( ( nodeVar273 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar283 = fract( nodeVar271 );
					nodeVar284 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar273 - ( floor( ( nodeVar273 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar281 - ( floor( ( nodeVar281 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar285 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar281 - ( floor( ( nodeVar281 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar281 - ( floor( ( nodeVar281 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar270 = mix( mix( nodeVar280.x, nodeVar282.x, nodeVar283.x ), mix( nodeVar284.x, nodeVar285.x, nodeVar283.x ), nodeVar283.y );

				} else {

					nodeVar270 = nodeVar232;

				}

				nodeVar287 = ( ( vec2<f32>( nodeVar237.x, ( nodeVar237.y - 8.0 ) ) / vec2<f32>( object.nodeUniform51 ) ) - object.nodeUniform52 );
				nodeVar288 = floor( nodeVar287 );
				nodeVar289 = ( nodeVar288 + object.nodeUniform52 );
				nodeVar290 = ( vec2<i32>( floor( ( nodeVar289 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( nodeVar289 / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar291 = textureLoad( nodeUniform54, nodeVar290, u32( 0u ) );
				nodeVar292 = ( vec2<i32>( floor( ( ( nodeVar289 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ) - ( vec2<i32>( i32( floor( ( f32( vec2<i32>( floor( ( ( nodeVar289 + vec2<f32>( 1.0 ) ) / vec2<f32>( f32( object.nodeUniform55 ) ) ) ) ).x ) / f32( object.nodeUniform56 ) ) ) ) ) * vec2<i32>( object.nodeUniform56 ) ) );
				nodeVar293 = textureLoad( nodeUniform54, nodeVar292, u32( 0u ) );
				nodeVar294 = textureLoad( nodeUniform54, vec2<i32>( nodeVar292.x, nodeVar290.y ), u32( 0u ) );
				nodeVar295 = textureLoad( nodeUniform54, vec2<i32>( nodeVar290.x, nodeVar292.y ), u32( 0u ) );

				if ( ( ( ( ( ( ( ( ( nodeVar288.x >= 0.0 ) && ( nodeVar288.y >= 0.0 ) ) && ( nodeVar288.x < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar288.y < ( object.nodeUniform53 - 1.0 ) ) ) && ( nodeVar291.x > 0.5 ) ) && ( nodeVar293.x > 0.5 ) ) && ( nodeVar294.x > 0.5 ) ) && ( nodeVar295.x > 0.5 ) ) ) {

					nodeVar296 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar289 - ( floor( ( nodeVar289 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar289 - ( floor( ( nodeVar289 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar297 = ( nodeVar289 + vec2<f32>( 1.0 ) );
					nodeVar298 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar297 - ( floor( ( nodeVar297 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar289 - ( floor( ( nodeVar289 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar299 = fract( nodeVar287 );
					nodeVar300 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar289 - ( floor( ( nodeVar289 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar297 - ( floor( ( nodeVar297 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar301 = textureLoad( nodeUniform57, vec2<i32>( vec2<i32>( ( nodeVar297 - ( floor( ( nodeVar297 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).x, vec2<i32>( ( nodeVar297 - ( floor( ( nodeVar297 / vec2<f32>( object.nodeUniform53 ) ) ) * vec2<f32>( object.nodeUniform53 ) ) ) ).y ), u32( 0u ) );
					nodeVar286 = mix( mix( nodeVar296.x, nodeVar298.x, nodeVar299.x ), mix( nodeVar300.x, nodeVar301.x, nodeVar299.x ), nodeVar299.y );

				} else {

					nodeVar286 = nodeVar232;

				}

				nodeVar302 = ( ( nodeVar270 - nodeVar286 ) / ( 8.0 * 2.0 ) );
				nodeVar303 = ( 1.0 / sqrt( ( ( ( nodeVar269 * nodeVar269 ) + ( nodeVar302 * nodeVar302 ) ) + 1.0 ) ) );
				nodeVar304 = ( 1.0 - smoothstep( ( object.nodeUniform82 - 1.5 ), ( object.nodeUniform82 + 1.5 ), nodeVar232 ) );
				nodeVar305 = ( 1.0 - smoothstep( object.nodeUniform83, object.nodeUniform84, nodeVar303 ) );
				nodeVar306 = ( 1.0 - nodeVar305 );
				nodeVar307 = ( 1.0 - nodeVar304 );
				nodeVar308 = smoothstep( object.nodeUniform85, object.nodeUniform86, nodeVar232 );
				nodeVar309 = smoothstep( object.nodeUniform87, object.nodeUniform88, nodeVar232 );
				nodeVar310 = vec4<f32>( ( nodeVar304 * nodeVar306 ), ( ( ( nodeVar307 * ( 1.0 - nodeVar308 ) ) * ( 1.0 - nodeVar309 ) ) * nodeVar306 ), ( ( ( nodeVar307 * nodeVar308 ) * ( 1.0 - nodeVar309 ) ) * nodeVar306 ), nodeVar305 );
				nodeVar311 = ( vec2<f32>( nodeVar32, nodeVar36 ) * vec2<f32>( object.nodeUniform90 ) );
				nodeVar312 = textureSampleLevel( nodeUniform89, nodeUniform89_sampler, nodeVar311, object.nodeUniform91 );
				nodeVar313 = textureSampleLevel( nodeUniform92, nodeUniform92_sampler, nodeVar311, object.nodeUniform91 );
				nodeVar314 = textureSampleLevel( nodeUniform93, nodeUniform93_sampler, nodeVar311, object.nodeUniform91 );
				nodeVar315 = textureSampleLevel( nodeUniform94, nodeUniform94_sampler, nodeVar311, object.nodeUniform91 );
				nodeVar316 = textureSampleLevel( nodeUniform95, nodeUniform95_sampler, nodeVar311, object.nodeUniform91 );
				nodeVar317 = mix( mix( nodeVar231, vec3<f32>( 0.42, 0.4, 0.38 ), clamp( ( ( 0.82 - nodeVar303 ) / 0.25 ), 0.0, 1.0 ) ), ( ( ( ( ( nodeVar312.xyz * vec3<f32>( nodeVar310.x ) ) + ( nodeVar313.xyz * vec3<f32>( nodeVar310.y ) ) ) + ( nodeVar314.xyz * vec3<f32>( nodeVar310.z ) ) ) + ( nodeVar315.xyz * vec3<f32>( nodeVar310.w ) ) ) + ( nodeVar316.xyz * vec3<f32>( max( ( 1.0 - ( ( ( nodeVar310.x + nodeVar310.y ) + nodeVar310.z ) + nodeVar310.w ) ), 0.0 ) ) ) ), object.nodeUniform96 );
				NodeBuffer_1265.value[ ( nodeVar224 + 1u ) ] = vec4<f32>( ( ( f32( ( nodeVar230 ^ ( nodeVar230 >> 16u ) ) ) / 4294967296.0 ) * 6.2831853 ), nodeVar317.x, nodeVar317.y, nodeVar317.z );
				

			}

			

		}

		

	}


	

}
