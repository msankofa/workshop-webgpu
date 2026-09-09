// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform17_sampler : sampler;
@binding( 2 ) @group( 1 ) var nodeUniform17 : texture_2d<f32>;

struct objectStruct {
	nodeUniform1 : u32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : vec3<f32>,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform9 : mat3x3<f32>,
	nodeUniform10 : vec3<f32>,
	nodeUniform11 : f32,
	nodeUniform16 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform13 : vec3<f32>,
	nodeUniform14 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar5 : vec3<f32>;
var<private> nodeVar6 : vec4<f32>;
var<private> nodeVar7 : vec4<f32>;
var<private> nodeVar8 : vec3<f32>;
var<private> nodeVar9 : vec3<f32>;
var<private> nodeVar10 : f32;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar16 : vec3<f32>;
var<private> nodeVar17 : f32;
var<private> nodeVar18 : f32;
var<private> nodeVar19 : f32;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec4<f32>;
var<private> nodeVar22 : vec3<f32>;
var<private> nodeVar23 : f32;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : vec3<f32>;
var<private> nodeVar26 : vec3<f32>;
var<private> nodeVar27 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar28 : vec3<f32>;
var<private> nodeVar29 : vec3<f32>;
var<private> nodeVar30 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar31 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar32 : f32;
var<private> nodeVar33 : vec4<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> nodeVar35 : f32;
var<private> nodeVar36 : vec3<f32>;
var<private> nodeVar37 : vec3<f32>;
var<private> nodeVar38 : vec3<f32>;
var<private> nodeVar39 : vec3<f32>;
var<private> nodeVar40 : vec3<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> nodeVar42 : vec3<f32>;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : f32;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : vec3<f32>;
var<private> nodeVar47 : vec3<f32>;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> nodeVar51 : vec3<f32>;
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
var<private> radiance : vec3<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : f32;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : f32;
var<private> nodeVar91 : f32;
var<private> nodeVar92 : f32;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : f32;
var<private> nodeVar97 : f32;
var<private> nodeVar98 : f32;
var<private> nodeVar99 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec4<f32>;

// codes
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
fn main( @location( 0 ) v_normalViewGeometry : vec3<f32>,
	@location( 1 ) v_forestNormal : vec3<f32>,
	@location( 2 ) v_positionViewDirection : vec3<f32>,
	@location( 3 ) nodeVarying7 : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	DiffuseColor = ( vec4<f32>( object.nodeUniform4, 1.0 ) * nodeVarying7 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform5 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform6;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar4 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform7, 0.0525 ) + max( max( nodeVar4.x, nodeVar4.y ), nodeVar4.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform6 ) ) );
	EmissiveColor = ( object.nodeUniform10 * vec3<f32>( object.nodeUniform11 ) );
	normalView = v_forestNormal;
	nodeVar5 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar6 = vec4<f32>( nodeVar5, 0.0 );
	nodeVar7 = ( render.cameraViewMatrix * nodeVar6 );
	nodeVar8 = normalize( nodeVar7.xyz );
	nodeVar9 = nodeVar8;
	nodeVar10 = dot( normalView, nodeVar9 );
	nodeVar11 = ( vec3<f32>( clamp( nodeVar10, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar12 = nodeVar11;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar13 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar14 = ( nodeVar12 * nodeVar13 );
	nodeVar15 = ( directDiffuse + nodeVar14 );
	directDiffuse = nodeVar15;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar16 = normalize( ( nodeVar9 + positionViewDirection ) );
	nodeVar17 = clamp( dot( positionViewDirection, nodeVar16 ), 0.0, 1.0 );
	nodeVar18 = exp2( ( ( ( nodeVar17 * -5.55473 ) - 6.98316 ) * nodeVar17 ) );
	nodeVar19 = ( Roughness * Roughness );
	nodeVar20 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar21 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar9 ), 0.0, 1.0 ) ) );
	nodeVar22 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar23 = ( 1.0 - ( nodeVar20.xy.x + nodeVar20.xy.y ) );
	nodeVar24 = ( 1.0 - ( nodeVar21.xy.x + nodeVar21.xy.y ) );
	nodeVar25 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar18 ) ) ) + vec3<f32>( ( 1.0 * nodeVar18 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar19, clamp( dot( normalView, nodeVar9 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar19, clamp( dot( normalView, nodeVar16 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar20.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar20.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar21.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar21.xy.y ) ) ) ) * nodeVar22 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar23 * nodeVar24 ) ) * nodeVar22 ) * nodeVar22 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar23 * nodeVar24 ) ) ) );
	nodeVar26 = ( nodeVar12 * nodeVar25 );
	nodeVar27 = ( directSpecular + nodeVar26 );
	directSpecular = nodeVar27;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar28 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar29 = ( irradiance * nodeVar28 );
	nodeVar30 = nodeVar29;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar31 = ( indirectDiffuse + nodeVar30 );
	indirectDiffuse = nodeVar31;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar32 = dot( normalView, positionViewDirection );
	nodeVar33 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar32, 0.0, 1.0 ) ) );
	nodeVar34 = ( SpecularColor * vec3<f32>( nodeVar33.xy.x ) );
	nodeVar35 = ( SpecularF90 * nodeVar33.xy.y );
	nodeVar36 = ( nodeVar34 + vec3<f32>( nodeVar35 ) );
	nodeVar37 = ( singleScatteringDielectric + nodeVar36 );
	singleScatteringDielectric = nodeVar37;
	nodeVar38 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar39 = nodeVar38;
	nodeVar40 = ( nodeVar39 * vec3<f32>( 0.047619 ) );
	nodeVar41 = ( SpecularColor + nodeVar40 );
	nodeVar42 = ( nodeVar36 * nodeVar41 );
	nodeVar43 = ( nodeVar33.xy.x + nodeVar33.xy.y );
	nodeVar44 = ( 1.0 - nodeVar43 );
	nodeVar45 = nodeVar44;
	nodeVar46 = ( vec3<f32>( nodeVar45 ) * nodeVar41 );
	nodeVar47 = ( vec3<f32>( 1.0 ) - nodeVar46 );
	nodeVar48 = nodeVar47;
	nodeVar49 = ( nodeVar42 / nodeVar48 );
	nodeVar50 = ( nodeVar49 * vec3<f32>( nodeVar45 ) );
	nodeVar51 = ( multiScatteringDielectric + nodeVar50 );
	multiScatteringDielectric = nodeVar51;
	nodeVar52 = dot( normalView, positionViewDirection );
	nodeVar53 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar52, 0.0, 1.0 ) ) );
	nodeVar54 = ( DiffuseColor.xyz * vec3<f32>( nodeVar53.xy.x ) );
	nodeVar55 = ( SpecularF90 * nodeVar53.xy.y );
	nodeVar56 = ( nodeVar54 + vec3<f32>( nodeVar55 ) );
	nodeVar57 = ( singleScatteringMetallic + nodeVar56 );
	singleScatteringMetallic = nodeVar57;
	nodeVar58 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar59 = nodeVar58;
	nodeVar60 = ( nodeVar59 * vec3<f32>( 0.047619 ) );
	nodeVar61 = ( DiffuseColor.xyz + nodeVar60 );
	nodeVar62 = ( nodeVar56 * nodeVar61 );
	nodeVar63 = ( nodeVar53.xy.x + nodeVar53.xy.y );
	nodeVar64 = ( 1.0 - nodeVar63 );
	nodeVar65 = nodeVar64;
	nodeVar66 = ( vec3<f32>( nodeVar65 ) * nodeVar61 );
	nodeVar67 = ( vec3<f32>( 1.0 ) - nodeVar66 );
	nodeVar68 = nodeVar67;
	nodeVar69 = ( nodeVar62 / nodeVar68 );
	nodeVar70 = ( nodeVar69 * vec3<f32>( nodeVar65 ) );
	nodeVar71 = ( multiScatteringMetallic + nodeVar70 );
	multiScatteringMetallic = nodeVar71;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar72 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar73 = ( radiance * nodeVar72 );
	nodeVar74 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar75 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar76 = ( nodeVar74 * nodeVar75 );
	nodeVar77 = ( nodeVar73 + nodeVar76 );
	nodeVar78 = nodeVar77;
	nodeVar79 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar80 = ( vec3<f32>( 1.0 ) - nodeVar79 );
	nodeVar81 = nodeVar80;
	nodeVar82 = ( DiffuseContribution * nodeVar81 );
	nodeVar83 = ( nodeVar82 * nodeVar75 );
	nodeVar84 = nodeVar83;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar85 = ( indirectSpecular + nodeVar78 );
	indirectSpecular = nodeVar85;
	nodeVar86 = ( indirectDiffuse + nodeVar84 );
	indirectDiffuse = nodeVar86;
	ambientOcclusion = 1.0;
	nodeVar87 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar87;
	nodeVar88 = dot( normalView, positionViewDirection );
	nodeVar89 = ( clamp( nodeVar88, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar90 = ( Roughness * -16.0 );
	nodeVar91 = ( 1.0 - nodeVar90 );
	nodeVar92 = nodeVar91;
	nodeVar93 = ( - nodeVar92 );
	nodeVar94 = exp2( nodeVar93 );
	nodeVar95 = pow( nodeVar89, nodeVar94 );
	nodeVar96 = ( 1.0 - nodeVar95 );
	nodeVar97 = nodeVar96;
	nodeVar98 = ( ambientOcclusion - nodeVar97 );
	nodeVar99 = ( indirectSpecular * vec3<f32>( clamp( nodeVar98, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar99;
	nodeVar100 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar100;
	nodeVar101 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar101;
	nodeVar102 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar102;
	nodeVar103 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar103;

	// result

	output.color = nodeVar103;

	return output;

}
