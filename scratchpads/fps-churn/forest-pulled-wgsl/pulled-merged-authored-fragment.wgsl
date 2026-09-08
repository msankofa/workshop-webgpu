// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 1 ) var nodeUniform5 : texture_2d<f32>;
@binding( 2 ) @group( 1 ) var nodeUniform13 : texture_2d<f32>;
@binding( 3 ) @group( 1 ) var nodeUniform19_sampler : sampler;
@binding( 4 ) @group( 1 ) var nodeUniform19 : texture_2d<f32>;

struct objectStruct {
	nodeUniform4 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform10 : mat3x3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : f32,
	nodeUniform18 : mat4x4<f32>
};
@binding( 1 ) @group( 1 )
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

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> nodeVar9 : vec4<f32>;
var<private> nodeVar10 : vec2<u32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> nodeVar13 : f32;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : vec3<f32>;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec3<f32>;
var<private> nodeVar18 : vec2<f32>;
var<private> nodeVar19 : vec3<f32>;
var<private> nodeVar20 : vec3<f32>;
var<private> nodeVar21 : f32;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec2<u32>;
var<private> nodeVar24 : vec3<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar25 : vec3<f32>;
var<private> nodeVar26 : vec4<f32>;
var<private> nodeVar27 : vec4<f32>;
var<private> nodeVar28 : vec3<f32>;
var<private> nodeVar29 : vec3<f32>;
var<private> nodeVar30 : f32;
var<private> nodeVar31 : vec3<f32>;
var<private> nodeVar32 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar33 : vec3<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> nodeVar35 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar36 : vec3<f32>;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : f32;
var<private> nodeVar39 : f32;
var<private> nodeVar40 : vec4<f32>;
var<private> nodeVar41 : vec4<f32>;
var<private> nodeVar42 : vec3<f32>;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : f32;
var<private> nodeVar45 : vec3<f32>;
var<private> nodeVar46 : vec3<f32>;
var<private> nodeVar47 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar51 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar52 : f32;
var<private> nodeVar53 : vec4<f32>;
var<private> nodeVar54 : vec3<f32>;
var<private> nodeVar55 : f32;
var<private> nodeVar56 : vec3<f32>;
var<private> nodeVar57 : vec3<f32>;
var<private> nodeVar58 : vec3<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : vec3<f32>;
var<private> nodeVar61 : vec3<f32>;
var<private> nodeVar62 : vec3<f32>;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : f32;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : f32;
var<private> nodeVar73 : vec4<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> nodeVar75 : f32;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : f32;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : vec3<f32>;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar105 : vec3<f32>;
var<private> nodeVar106 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : f32;
var<private> nodeVar109 : f32;
var<private> nodeVar110 : f32;
var<private> nodeVar111 : f32;
var<private> nodeVar112 : f32;
var<private> nodeVar113 : f32;
var<private> nodeVar114 : f32;
var<private> nodeVar115 : f32;
var<private> nodeVar116 : f32;
var<private> nodeVar117 : f32;
var<private> nodeVar118 : f32;
var<private> nodeVar119 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec4<f32>;

// codes
fn tsl_clampWrapping_float( coord: f32 ) -> f32 { return clamp( coord, 0.0, 1.0 ); }
fn tsl_coord_clampS_clamp_2dT( coord : vec2f ) -> vec2f {

	return vec2f(
		tsl_clampWrapping_float( coord.x ),
		tsl_clampWrapping_float( coord.y )
	);

}

fn V_GGX_SmithCorrelated ( alpha : f32, dotNL : f32, dotNV : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = ( alpha * alpha );

	return ( 0.5 / max( ( ( dotNL * sqrt( ( nodeVar0 + ( ( 1.0 - nodeVar0 ) * ( dotNV * dotNV ) ) ) ) ) + ( dotNV * sqrt( ( nodeVar0 + ( ( 1.0 - nodeVar0 ) * ( dotNL * dotNL ) ) ) ) ) ), 0.000001 ) );

}

fn D_GGX ( alpha : f32, dotNH : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;

	nodeVar0 = ( alpha * alpha );
	nodeVar1 = ( 1.0 - ( ( dotNH * dotNH ) * ( 1.0 - nodeVar0 ) ) );

	return ( ( nodeVar0 / ( nodeVar1 * nodeVar1 ) ) * 0.3183098861837907 );

}



@fragment
fn main( @location( 0 ) v_pulledUv : vec2<f32>,
	@location( 1 ) v_pulledColor : vec3<f32>,
	@location( 2 ) v_normalViewGeometry : vec3<f32>,
	@location( 3 ) v_pulledWorld : vec3<f32>,
	@location( 4 ) v_pulledNormal : vec3<f32>,
	@location( 5 ) v_positionViewDirection : vec3<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar10 = textureDimensions( nodeUniform5, u32( 0 ) );
	nodeVar9 = textureLoad( nodeUniform5, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( v_pulledUv ) * vec2<f32>( nodeVar10 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar10 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
	DiffuseColor = vec4<f32>( ( nodeVar9.xyz * v_pulledColor ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform6 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform7;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar11 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform8, 0.0525 ) + max( max( nodeVar11.x, nodeVar11.y ), nodeVar11.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform7 ) ) );
	EmissiveColor = ( object.nodeUniform11 * vec3<f32>( object.nodeUniform12 ) );
	nodeVar14 = normalize( v_pulledNormal );
	nodeVar15 = cross( - dpdy( v_pulledWorld ), nodeVar14 );
	nodeVar16 = dpdx( v_pulledUv );
	nodeVar17 = cross( nodeVar14, dpdx( v_pulledWorld ) );
	nodeVar18 = - dpdy( v_pulledUv );
	nodeVar19 = ( ( nodeVar15 * vec3<f32>( nodeVar16.x ) ) + ( nodeVar17 * vec3<f32>( nodeVar18.x ) ) );
	nodeVar20 = ( ( nodeVar15 * vec3<f32>( nodeVar16.y ) ) + ( nodeVar17 * vec3<f32>( nodeVar18.y ) ) );
	nodeVar21 = max( dot( nodeVar19, nodeVar19 ), dot( nodeVar20, nodeVar20 ) );

	if ( ( nodeVar21 > 0.0 ) ) {

		nodeVar13 = inverseSqrt( nodeVar21 );

	} else {

		nodeVar13 = 0.0;

	}


	if ( ( nodeVar13 > 0.0 ) ) {

		nodeVar23 = textureDimensions( nodeUniform13, u32( 0 ) );
		nodeVar22 = textureLoad( nodeUniform13, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( v_pulledUv ) * vec2<f32>( nodeVar23 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar23 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
		nodeVar24 = ( ( nodeVar22.xyz * vec3<f32>( 2.0 ) ) - vec3<f32>( 1.0 ) );
		nodeVar12 = normalize( ( ( ( ( nodeVar19 * nodeVar13 ) * vec3<f32>( ( nodeVar24.x * 1.0 ) ) ) + ( ( nodeVar20 * nodeVar13 ) * vec3<f32>( ( nodeVar24.y * 1.0 ) ) ) ) + ( nodeVar14 * vec3<f32>( nodeVar24.z ) ) ) );

	} else {

		nodeVar12 = nodeVar14;

	}

	normalView = nodeVar12;
	nodeVar25 = ( render.nodeUniform15 - render.nodeUniform16 );
	nodeVar26 = vec4<f32>( nodeVar25, 0.0 );
	nodeVar27 = ( render.cameraViewMatrix * nodeVar26 );
	nodeVar28 = normalize( nodeVar27.xyz );
	nodeVar29 = nodeVar28;
	nodeVar30 = dot( normalView, nodeVar29 );
	nodeVar31 = ( vec3<f32>( clamp( nodeVar30, 0.0, 1.0 ) ) * render.nodeUniform17 );
	nodeVar32 = nodeVar31;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar33 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar34 = ( nodeVar32 * nodeVar33 );
	nodeVar35 = ( directDiffuse + nodeVar34 );
	directDiffuse = nodeVar35;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar36 = normalize( ( nodeVar29 + positionViewDirection ) );
	nodeVar37 = clamp( dot( positionViewDirection, nodeVar36 ), 0.0, 1.0 );
	nodeVar38 = exp2( ( ( ( nodeVar37 * -5.55473 ) - 6.98316 ) * nodeVar37 ) );
	nodeVar39 = ( Roughness * Roughness );
	nodeVar40 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar41 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar29 ), 0.0, 1.0 ) ) );
	nodeVar42 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar43 = ( 1.0 - ( nodeVar40.xy.x + nodeVar40.xy.y ) );
	nodeVar44 = ( 1.0 - ( nodeVar41.xy.x + nodeVar41.xy.y ) );
	nodeVar45 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar38 ) ) ) + vec3<f32>( ( 1.0 * nodeVar38 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar39, clamp( dot( normalView, nodeVar29 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar39, clamp( dot( normalView, nodeVar36 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar40.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar40.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar41.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar41.xy.y ) ) ) ) * nodeVar42 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar43 * nodeVar44 ) ) * nodeVar42 ) * nodeVar42 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar43 * nodeVar44 ) ) ) );
	nodeVar46 = ( nodeVar32 * nodeVar45 );
	nodeVar47 = ( directSpecular + nodeVar46 );
	directSpecular = nodeVar47;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar48 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar49 = ( irradiance * nodeVar48 );
	nodeVar50 = nodeVar49;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar51 = ( indirectDiffuse + nodeVar50 );
	indirectDiffuse = nodeVar51;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar52 = dot( normalView, positionViewDirection );
	nodeVar53 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar52, 0.0, 1.0 ) ) );
	nodeVar54 = ( SpecularColor * vec3<f32>( nodeVar53.xy.x ) );
	nodeVar55 = ( SpecularF90 * nodeVar53.xy.y );
	nodeVar56 = ( nodeVar54 + vec3<f32>( nodeVar55 ) );
	nodeVar57 = ( singleScatteringDielectric + nodeVar56 );
	singleScatteringDielectric = nodeVar57;
	nodeVar58 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar59 = nodeVar58;
	nodeVar60 = ( nodeVar59 * vec3<f32>( 0.047619 ) );
	nodeVar61 = ( SpecularColor + nodeVar60 );
	nodeVar62 = ( nodeVar56 * nodeVar61 );
	nodeVar63 = ( nodeVar53.xy.x + nodeVar53.xy.y );
	nodeVar64 = ( 1.0 - nodeVar63 );
	nodeVar65 = nodeVar64;
	nodeVar66 = ( vec3<f32>( nodeVar65 ) * nodeVar61 );
	nodeVar67 = ( vec3<f32>( 1.0 ) - nodeVar66 );
	nodeVar68 = nodeVar67;
	nodeVar69 = ( nodeVar62 / nodeVar68 );
	nodeVar70 = ( nodeVar69 * vec3<f32>( nodeVar65 ) );
	nodeVar71 = ( multiScatteringDielectric + nodeVar70 );
	multiScatteringDielectric = nodeVar71;
	nodeVar72 = dot( normalView, positionViewDirection );
	nodeVar73 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar72, 0.0, 1.0 ) ) );
	nodeVar74 = ( DiffuseColor.xyz * vec3<f32>( nodeVar73.xy.x ) );
	nodeVar75 = ( SpecularF90 * nodeVar73.xy.y );
	nodeVar76 = ( nodeVar74 + vec3<f32>( nodeVar75 ) );
	nodeVar77 = ( singleScatteringMetallic + nodeVar76 );
	singleScatteringMetallic = nodeVar77;
	nodeVar78 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar79 = nodeVar78;
	nodeVar80 = ( nodeVar79 * vec3<f32>( 0.047619 ) );
	nodeVar81 = ( DiffuseColor.xyz + nodeVar80 );
	nodeVar82 = ( nodeVar76 * nodeVar81 );
	nodeVar83 = ( nodeVar73.xy.x + nodeVar73.xy.y );
	nodeVar84 = ( 1.0 - nodeVar83 );
	nodeVar85 = nodeVar84;
	nodeVar86 = ( vec3<f32>( nodeVar85 ) * nodeVar81 );
	nodeVar87 = ( vec3<f32>( 1.0 ) - nodeVar86 );
	nodeVar88 = nodeVar87;
	nodeVar89 = ( nodeVar82 / nodeVar88 );
	nodeVar90 = ( nodeVar89 * vec3<f32>( nodeVar85 ) );
	nodeVar91 = ( multiScatteringMetallic + nodeVar90 );
	multiScatteringMetallic = nodeVar91;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar92 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar93 = ( radiance * nodeVar92 );
	nodeVar94 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar95 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar96 = ( nodeVar94 * nodeVar95 );
	nodeVar97 = ( nodeVar93 + nodeVar96 );
	nodeVar98 = nodeVar97;
	nodeVar99 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar100 = ( vec3<f32>( 1.0 ) - nodeVar99 );
	nodeVar101 = nodeVar100;
	nodeVar102 = ( DiffuseContribution * nodeVar101 );
	nodeVar103 = ( nodeVar102 * nodeVar95 );
	nodeVar104 = nodeVar103;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar105 = ( indirectSpecular + nodeVar98 );
	indirectSpecular = nodeVar105;
	nodeVar106 = ( indirectDiffuse + nodeVar104 );
	indirectDiffuse = nodeVar106;
	ambientOcclusion = 1.0;
	nodeVar107 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar107;
	nodeVar108 = dot( normalView, positionViewDirection );
	nodeVar109 = ( clamp( nodeVar108, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar110 = ( Roughness * -16.0 );
	nodeVar111 = ( 1.0 - nodeVar110 );
	nodeVar112 = nodeVar111;
	nodeVar113 = ( - nodeVar112 );
	nodeVar114 = exp2( nodeVar113 );
	nodeVar115 = pow( nodeVar109, nodeVar114 );
	nodeVar116 = ( 1.0 - nodeVar115 );
	nodeVar117 = nodeVar116;
	nodeVar118 = ( ambientOcclusion - nodeVar117 );
	nodeVar119 = ( indirectSpecular * vec3<f32>( clamp( nodeVar118, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar119;
	nodeVar120 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar120;
	nodeVar121 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar121;
	nodeVar122 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar122;
	nodeVar123 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar123;

	// result

	output.color = nodeVar123;

	return output;

}
