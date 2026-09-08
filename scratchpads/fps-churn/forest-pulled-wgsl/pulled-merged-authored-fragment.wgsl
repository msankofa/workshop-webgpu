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
var<private> nodeVar8 : vec4<f32>;
var<private> nodeVar9 : vec2<u32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar10 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : vec2<f32>;
var<private> nodeVar16 : vec3<f32>;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec3<f32>;
var<private> nodeVar20 : f32;
var<private> nodeVar21 : vec4<f32>;
var<private> nodeVar22 : vec2<u32>;
var<private> nodeVar23 : vec3<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar24 : vec3<f32>;
var<private> nodeVar25 : vec4<f32>;
var<private> nodeVar26 : vec4<f32>;
var<private> nodeVar27 : vec3<f32>;
var<private> nodeVar28 : vec3<f32>;
var<private> nodeVar29 : f32;
var<private> nodeVar30 : vec3<f32>;
var<private> nodeVar31 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar32 : vec3<f32>;
var<private> nodeVar33 : vec3<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar35 : vec3<f32>;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : f32;
var<private> nodeVar39 : vec4<f32>;
var<private> nodeVar40 : vec4<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> nodeVar42 : f32;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : vec3<f32>;
var<private> nodeVar45 : vec3<f32>;
var<private> nodeVar46 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar47 : vec3<f32>;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar51 : f32;
var<private> nodeVar52 : vec4<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : f32;
var<private> nodeVar55 : vec3<f32>;
var<private> nodeVar56 : vec3<f32>;
var<private> nodeVar57 : vec3<f32>;
var<private> nodeVar58 : vec3<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : vec3<f32>;
var<private> nodeVar61 : vec3<f32>;
var<private> nodeVar62 : f32;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : f32;
var<private> nodeVar72 : vec4<f32>;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : f32;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : f32;
var<private> nodeVar83 : f32;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : vec3<f32>;
var<private> nodeVar90 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : f32;
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
var<private> nodeVar118 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec4<f32>;

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

	nodeVar9 = textureDimensions( nodeUniform5, u32( 0 ) );
	nodeVar8 = textureLoad( nodeUniform5, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( v_pulledUv ) * vec2<f32>( nodeVar9 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar9 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
	DiffuseColor = vec4<f32>( ( nodeVar8.xyz * v_pulledColor ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform6 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform7;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar10 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform8, 0.0525 ) + max( max( nodeVar10.x, nodeVar10.y ), nodeVar10.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform7 ) ) );
	EmissiveColor = ( object.nodeUniform11 * vec3<f32>( object.nodeUniform12 ) );
	nodeVar13 = normalize( v_pulledNormal );
	nodeVar14 = cross( - dpdy( v_pulledWorld ), nodeVar13 );
	nodeVar15 = dpdx( v_pulledUv );
	nodeVar16 = cross( nodeVar13, dpdx( v_pulledWorld ) );
	nodeVar17 = - dpdy( v_pulledUv );
	nodeVar18 = ( ( nodeVar14 * vec3<f32>( nodeVar15.x ) ) + ( nodeVar16 * vec3<f32>( nodeVar17.x ) ) );
	nodeVar19 = ( ( nodeVar14 * vec3<f32>( nodeVar15.y ) ) + ( nodeVar16 * vec3<f32>( nodeVar17.y ) ) );
	nodeVar20 = max( dot( nodeVar18, nodeVar18 ), dot( nodeVar19, nodeVar19 ) );

	if ( ( nodeVar20 > 0.0 ) ) {

		nodeVar12 = inverseSqrt( nodeVar20 );

	} else {

		nodeVar12 = 0.0;

	}


	if ( ( nodeVar12 > 0.0 ) ) {

		nodeVar22 = textureDimensions( nodeUniform13, u32( 0 ) );
		nodeVar21 = textureLoad( nodeUniform13, vec2<u32>( clamp( floor( tsl_coord_clampS_clamp_2dT( v_pulledUv ) * vec2<f32>( nodeVar22 ) ), vec2<f32>( 0 ), vec2<f32>( nodeVar22 - vec2<u32>( 1, 1 ) ) ) ), u32( 0 ) );
		nodeVar23 = ( ( nodeVar21.xyz * vec3<f32>( 2.0 ) ) - vec3<f32>( 1.0 ) );
		nodeVar11 = normalize( ( ( ( ( nodeVar18 * nodeVar12 ) * vec3<f32>( ( nodeVar23.x * 1.0 ) ) ) + ( ( nodeVar19 * nodeVar12 ) * vec3<f32>( ( nodeVar23.y * 1.0 ) ) ) ) + ( nodeVar13 * vec3<f32>( nodeVar23.z ) ) ) );

	} else {

		nodeVar11 = nodeVar13;

	}

	normalView = nodeVar11;
	nodeVar24 = ( render.nodeUniform15 - render.nodeUniform16 );
	nodeVar25 = vec4<f32>( nodeVar24, 0.0 );
	nodeVar26 = ( render.cameraViewMatrix * nodeVar25 );
	nodeVar27 = normalize( nodeVar26.xyz );
	nodeVar28 = nodeVar27;
	nodeVar29 = dot( normalView, nodeVar28 );
	nodeVar30 = ( vec3<f32>( clamp( nodeVar29, 0.0, 1.0 ) ) * render.nodeUniform17 );
	nodeVar31 = nodeVar30;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar32 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar33 = ( nodeVar31 * nodeVar32 );
	nodeVar34 = ( directDiffuse + nodeVar33 );
	directDiffuse = nodeVar34;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar35 = normalize( ( nodeVar28 + positionViewDirection ) );
	nodeVar36 = clamp( dot( positionViewDirection, nodeVar35 ), 0.0, 1.0 );
	nodeVar37 = exp2( ( ( ( nodeVar36 * -5.55473 ) - 6.98316 ) * nodeVar36 ) );
	nodeVar38 = ( Roughness * Roughness );
	nodeVar39 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar40 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar28 ), 0.0, 1.0 ) ) );
	nodeVar41 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar42 = ( 1.0 - ( nodeVar39.xy.x + nodeVar39.xy.y ) );
	nodeVar43 = ( 1.0 - ( nodeVar40.xy.x + nodeVar40.xy.y ) );
	nodeVar44 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar37 ) ) ) + vec3<f32>( ( 1.0 * nodeVar37 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar38, clamp( dot( normalView, nodeVar28 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar38, clamp( dot( normalView, nodeVar35 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar39.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar39.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar40.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar40.xy.y ) ) ) ) * nodeVar41 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar42 * nodeVar43 ) ) * nodeVar41 ) * nodeVar41 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar42 * nodeVar43 ) ) ) );
	nodeVar45 = ( nodeVar31 * nodeVar44 );
	nodeVar46 = ( directSpecular + nodeVar45 );
	directSpecular = nodeVar46;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar47 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar48 = ( irradiance * nodeVar47 );
	nodeVar49 = nodeVar48;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar50 = ( indirectDiffuse + nodeVar49 );
	indirectDiffuse = nodeVar50;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar51 = dot( normalView, positionViewDirection );
	nodeVar52 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar51, 0.0, 1.0 ) ) );
	nodeVar53 = ( SpecularColor * vec3<f32>( nodeVar52.xy.x ) );
	nodeVar54 = ( SpecularF90 * nodeVar52.xy.y );
	nodeVar55 = ( nodeVar53 + vec3<f32>( nodeVar54 ) );
	nodeVar56 = ( singleScatteringDielectric + nodeVar55 );
	singleScatteringDielectric = nodeVar56;
	nodeVar57 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar58 = nodeVar57;
	nodeVar59 = ( nodeVar58 * vec3<f32>( 0.047619 ) );
	nodeVar60 = ( SpecularColor + nodeVar59 );
	nodeVar61 = ( nodeVar55 * nodeVar60 );
	nodeVar62 = ( nodeVar52.xy.x + nodeVar52.xy.y );
	nodeVar63 = ( 1.0 - nodeVar62 );
	nodeVar64 = nodeVar63;
	nodeVar65 = ( vec3<f32>( nodeVar64 ) * nodeVar60 );
	nodeVar66 = ( vec3<f32>( 1.0 ) - nodeVar65 );
	nodeVar67 = nodeVar66;
	nodeVar68 = ( nodeVar61 / nodeVar67 );
	nodeVar69 = ( nodeVar68 * vec3<f32>( nodeVar64 ) );
	nodeVar70 = ( multiScatteringDielectric + nodeVar69 );
	multiScatteringDielectric = nodeVar70;
	nodeVar71 = dot( normalView, positionViewDirection );
	nodeVar72 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar71, 0.0, 1.0 ) ) );
	nodeVar73 = ( DiffuseColor.xyz * vec3<f32>( nodeVar72.xy.x ) );
	nodeVar74 = ( SpecularF90 * nodeVar72.xy.y );
	nodeVar75 = ( nodeVar73 + vec3<f32>( nodeVar74 ) );
	nodeVar76 = ( singleScatteringMetallic + nodeVar75 );
	singleScatteringMetallic = nodeVar76;
	nodeVar77 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar78 = nodeVar77;
	nodeVar79 = ( nodeVar78 * vec3<f32>( 0.047619 ) );
	nodeVar80 = ( DiffuseColor.xyz + nodeVar79 );
	nodeVar81 = ( nodeVar75 * nodeVar80 );
	nodeVar82 = ( nodeVar72.xy.x + nodeVar72.xy.y );
	nodeVar83 = ( 1.0 - nodeVar82 );
	nodeVar84 = nodeVar83;
	nodeVar85 = ( vec3<f32>( nodeVar84 ) * nodeVar80 );
	nodeVar86 = ( vec3<f32>( 1.0 ) - nodeVar85 );
	nodeVar87 = nodeVar86;
	nodeVar88 = ( nodeVar81 / nodeVar87 );
	nodeVar89 = ( nodeVar88 * vec3<f32>( nodeVar84 ) );
	nodeVar90 = ( multiScatteringMetallic + nodeVar89 );
	multiScatteringMetallic = nodeVar90;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar91 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar92 = ( radiance * nodeVar91 );
	nodeVar93 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar94 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar95 = ( nodeVar93 * nodeVar94 );
	nodeVar96 = ( nodeVar92 + nodeVar95 );
	nodeVar97 = nodeVar96;
	nodeVar98 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar99 = ( vec3<f32>( 1.0 ) - nodeVar98 );
	nodeVar100 = nodeVar99;
	nodeVar101 = ( DiffuseContribution * nodeVar100 );
	nodeVar102 = ( nodeVar101 * nodeVar94 );
	nodeVar103 = nodeVar102;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar104 = ( indirectSpecular + nodeVar97 );
	indirectSpecular = nodeVar104;
	nodeVar105 = ( indirectDiffuse + nodeVar103 );
	indirectDiffuse = nodeVar105;
	ambientOcclusion = 1.0;
	nodeVar106 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar106;
	nodeVar107 = dot( normalView, positionViewDirection );
	nodeVar108 = ( clamp( nodeVar107, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar109 = ( Roughness * -16.0 );
	nodeVar110 = ( 1.0 - nodeVar109 );
	nodeVar111 = nodeVar110;
	nodeVar112 = ( - nodeVar111 );
	nodeVar113 = exp2( nodeVar112 );
	nodeVar114 = pow( nodeVar108, nodeVar113 );
	nodeVar115 = ( 1.0 - nodeVar114 );
	nodeVar116 = nodeVar115;
	nodeVar117 = ( ambientOcclusion - nodeVar116 );
	nodeVar118 = ( indirectSpecular * vec3<f32>( clamp( nodeVar117, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar118;
	nodeVar119 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar119;
	nodeVar120 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar120;
	nodeVar121 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar121;
	nodeVar122 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar122;

	// result

	output.color = nodeVar122;

	return output;

}
