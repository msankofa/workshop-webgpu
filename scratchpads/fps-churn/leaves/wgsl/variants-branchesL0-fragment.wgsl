// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform15_sampler : sampler;
@binding( 2 ) @group( 1 ) var nodeUniform15 : texture_2d<f32>;

struct objectStruct {
	nodeUniform1 : u32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform7 : mat3x3<f32>,
	nodeUniform8 : vec3<f32>,
	nodeUniform9 : f32,
	nodeUniform14 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform13 : vec3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> nodeVar4 : vec2<f32>;
var<private> nodeVar5 : vec2<f32>;
var<private> nodeVar6 : vec2<f32>;
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : vec2<f32>;
var<private> nodeVar14 : vec2<f32>;
var<private> nodeVar15 : vec2<f32>;
var<private> nodeVar16 : f32;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec2<f32>;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec2<f32>;
var<private> nodeVar21 : vec2<f32>;
var<private> nodeVar22 : vec2<f32>;
var<private> nodeVar23 : vec2<f32>;
var<private> nodeVar24 : vec2<f32>;
var<private> nodeVar25 : vec2<f32>;
var<private> nodeVar26 : vec2<f32>;
var<private> nodeVar27 : vec2<f32>;
var<private> nodeVar28 : vec2<f32>;
var<private> nodeVar29 : vec2<f32>;
var<private> nodeVar30 : vec2<f32>;
var<private> nodeVar31 : vec2<f32>;
var<private> nodeVar32 : vec2<f32>;
var<private> nodeVar33 : vec2<f32>;
var<private> nodeVar34 : vec2<f32>;
var<private> nodeVar35 : vec2<f32>;
var<private> nodeVar36 : vec2<f32>;
var<private> nodeVar37 : vec2<f32>;
var<private> nodeVar38 : vec2<f32>;
var<private> nodeVar39 : vec2<f32>;
var<private> nodeVar40 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar42 : vec3<f32>;
var<private> nodeVar43 : vec4<f32>;
var<private> nodeVar44 : vec4<f32>;
var<private> nodeVar45 : vec3<f32>;
var<private> nodeVar46 : vec3<f32>;
var<private> nodeVar47 : f32;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> nodeVar51 : vec3<f32>;
var<private> nodeVar52 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : f32;
var<private> nodeVar55 : f32;
var<private> nodeVar56 : f32;
var<private> nodeVar57 : vec4<f32>;
var<private> nodeVar58 : vec4<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : f32;
var<private> nodeVar61 : f32;
var<private> nodeVar62 : vec3<f32>;
var<private> nodeVar63 : vec3<f32>;
var<private> nodeVar64 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar69 : f32;
var<private> nodeVar70 : vec4<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : f32;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : f32;
var<private> nodeVar81 : f32;
var<private> nodeVar82 : f32;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : vec4<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : f32;
var<private> nodeVar93 : vec3<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : f32;
var<private> nodeVar101 : f32;
var<private> nodeVar102 : f32;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : vec3<f32>;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : f32;
var<private> nodeVar126 : f32;
var<private> nodeVar127 : f32;
var<private> nodeVar128 : f32;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : f32;
var<private> nodeVar132 : f32;
var<private> nodeVar133 : f32;
var<private> nodeVar134 : f32;
var<private> nodeVar135 : f32;
var<private> nodeVar136 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar137 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar138 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> nodeVar140 : vec4<f32>;

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
	@location( 3 ) nodeVarying7 : vec3<f32>,
	@location( 4 ) nodeVarying8 : vec2<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar4 = vec2<f32>( ( nodeVarying8.x * 7.0 ), ( nodeVarying8.y * 1.35 ) );
	nodeVar5 = floor( nodeVar4 );
	nodeVar6 = fract( ( nodeVar5 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar7 = ( nodeVar6 + vec2<f32>( dot( nodeVar6, ( nodeVar6 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar8 = fract( ( ( nodeVar5 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar9 = ( nodeVar8 + vec2<f32>( dot( nodeVar8, ( nodeVar8 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar10 = fract( nodeVar4 );
	nodeVar11 = ( ( nodeVar10 * nodeVar10 ) * ( vec2<f32>( 3.0 ) - ( nodeVar10 * vec2<f32>( 2.0 ) ) ) );
	nodeVar12 = fract( ( ( nodeVar5 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar13 = ( nodeVar12 + vec2<f32>( dot( nodeVar12, ( nodeVar12 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar14 = fract( ( ( nodeVar5 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar15 = ( nodeVar14 + vec2<f32>( dot( nodeVar14, ( nodeVar14 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar16 = mix( mix( fract( ( nodeVar7.x * nodeVar7.y ) ), fract( ( nodeVar9.x * nodeVar9.y ) ), nodeVar11.x ), mix( fract( ( nodeVar13.x * nodeVar13.y ) ), fract( ( nodeVar15.x * nodeVar15.y ) ), nodeVar11.x ), nodeVar11.y );
	nodeVar17 = vec2<f32>( ( ( nodeVarying8.x * 16.0 ) + ( nodeVar16 * 2.0 ) ), ( nodeVarying8.y * 5.5 ) );
	nodeVar18 = floor( nodeVar17 );
	nodeVar19 = fract( ( nodeVar18 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar20 = ( nodeVar19 + vec2<f32>( dot( nodeVar19, ( nodeVar19 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar21 = fract( ( ( nodeVar18 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar22 = ( nodeVar21 + vec2<f32>( dot( nodeVar21, ( nodeVar21 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar23 = fract( nodeVar17 );
	nodeVar24 = ( ( nodeVar23 * nodeVar23 ) * ( vec2<f32>( 3.0 ) - ( nodeVar23 * vec2<f32>( 2.0 ) ) ) );
	nodeVar25 = fract( ( ( nodeVar18 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar26 = ( nodeVar25 + vec2<f32>( dot( nodeVar25, ( nodeVar25 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar27 = fract( ( ( nodeVar18 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar28 = ( nodeVar27 + vec2<f32>( dot( nodeVar27, ( nodeVar27 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar29 = vec2<f32>( ( nodeVarying8.x * 54.0 ), ( nodeVarying8.y * 18.0 ) );
	nodeVar30 = floor( nodeVar29 );
	nodeVar31 = fract( ( nodeVar30 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar32 = ( nodeVar31 + vec2<f32>( dot( nodeVar31, ( nodeVar31 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar33 = fract( ( ( nodeVar30 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar34 = ( nodeVar33 + vec2<f32>( dot( nodeVar33, ( nodeVar33 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar35 = fract( nodeVar29 );
	nodeVar36 = ( ( nodeVar35 * nodeVar35 ) * ( vec2<f32>( 3.0 ) - ( nodeVar35 * vec2<f32>( 2.0 ) ) ) );
	nodeVar37 = fract( ( ( nodeVar30 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar38 = ( nodeVar37 + vec2<f32>( dot( nodeVar37, ( nodeVar37 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar39 = fract( ( ( nodeVar30 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar40 = ( nodeVar39 + vec2<f32>( dot( nodeVar39, ( nodeVar39 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = ( vec4<f32>( ( nodeVarying7 * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( nodeVarying8.x * 42.0 ) + ( nodeVar16 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar20.x * nodeVar20.y ) ), fract( ( nodeVar22.x * nodeVar22.y ) ), nodeVar24.x ), mix( fract( ( nodeVar26.x * nodeVar26.y ) ), fract( ( nodeVar28.x * nodeVar28.y ) ), nodeVar24.x ), nodeVar24.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar16 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar32.x * nodeVar32.y ) ), fract( ( nodeVar34.x * nodeVar34.y ) ), nodeVar36.x ), mix( fract( ( nodeVar38.x * nodeVar38.y ) ), fract( ( nodeVar40.x * nodeVar40.y ) ), nodeVar36.x ), nodeVar36.y ) * 0.22 ) ) ) ) ), 1.0 ) * vec4<f32>( nodeVarying7, 1.0 ) );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform3 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform4;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar41 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform5, 0.0525 ) + max( max( nodeVar41.x, nodeVar41.y ), nodeVar41.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform4 ) ) );
	EmissiveColor = ( object.nodeUniform8 * vec3<f32>( object.nodeUniform9 ) );
	normalView = v_forestNormal;
	nodeVar42 = ( render.nodeUniform11 - render.nodeUniform12 );
	nodeVar43 = vec4<f32>( nodeVar42, 0.0 );
	nodeVar44 = ( render.cameraViewMatrix * nodeVar43 );
	nodeVar45 = normalize( nodeVar44.xyz );
	nodeVar46 = nodeVar45;
	nodeVar47 = dot( normalView, nodeVar46 );
	nodeVar48 = ( vec3<f32>( clamp( nodeVar47, 0.0, 1.0 ) ) * render.nodeUniform13 );
	nodeVar49 = nodeVar48;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar50 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar51 = ( nodeVar49 * nodeVar50 );
	nodeVar52 = ( directDiffuse + nodeVar51 );
	directDiffuse = nodeVar52;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar53 = normalize( ( nodeVar46 + positionViewDirection ) );
	nodeVar54 = clamp( dot( positionViewDirection, nodeVar53 ), 0.0, 1.0 );
	nodeVar55 = exp2( ( ( ( nodeVar54 * -5.55473 ) - 6.98316 ) * nodeVar54 ) );
	nodeVar56 = ( Roughness * Roughness );
	nodeVar57 = textureSample( nodeUniform15, nodeUniform15_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar58 = textureSample( nodeUniform15, nodeUniform15_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar46 ), 0.0, 1.0 ) ) );
	nodeVar59 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar60 = ( 1.0 - ( nodeVar57.xy.x + nodeVar57.xy.y ) );
	nodeVar61 = ( 1.0 - ( nodeVar58.xy.x + nodeVar58.xy.y ) );
	nodeVar62 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar55 ) ) ) + vec3<f32>( ( 1.0 * nodeVar55 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar56, clamp( dot( normalView, nodeVar46 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar56, clamp( dot( normalView, nodeVar53 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar57.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar57.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar58.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar58.xy.y ) ) ) ) * nodeVar59 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar60 * nodeVar61 ) ) * nodeVar59 ) * nodeVar59 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar60 * nodeVar61 ) ) ) );
	nodeVar63 = ( nodeVar49 * nodeVar62 );
	nodeVar64 = ( directSpecular + nodeVar63 );
	directSpecular = nodeVar64;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar65 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar66 = ( irradiance * nodeVar65 );
	nodeVar67 = nodeVar66;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar68 = ( indirectDiffuse + nodeVar67 );
	indirectDiffuse = nodeVar68;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar69 = dot( normalView, positionViewDirection );
	nodeVar70 = textureSample( nodeUniform15, nodeUniform15_sampler, vec2<f32>( Roughness, clamp( nodeVar69, 0.0, 1.0 ) ) );
	nodeVar71 = ( SpecularColor * vec3<f32>( nodeVar70.xy.x ) );
	nodeVar72 = ( SpecularF90 * nodeVar70.xy.y );
	nodeVar73 = ( nodeVar71 + vec3<f32>( nodeVar72 ) );
	nodeVar74 = ( singleScatteringDielectric + nodeVar73 );
	singleScatteringDielectric = nodeVar74;
	nodeVar75 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar76 = nodeVar75;
	nodeVar77 = ( nodeVar76 * vec3<f32>( 0.047619 ) );
	nodeVar78 = ( SpecularColor + nodeVar77 );
	nodeVar79 = ( nodeVar73 * nodeVar78 );
	nodeVar80 = ( nodeVar70.xy.x + nodeVar70.xy.y );
	nodeVar81 = ( 1.0 - nodeVar80 );
	nodeVar82 = nodeVar81;
	nodeVar83 = ( vec3<f32>( nodeVar82 ) * nodeVar78 );
	nodeVar84 = ( vec3<f32>( 1.0 ) - nodeVar83 );
	nodeVar85 = nodeVar84;
	nodeVar86 = ( nodeVar79 / nodeVar85 );
	nodeVar87 = ( nodeVar86 * vec3<f32>( nodeVar82 ) );
	nodeVar88 = ( multiScatteringDielectric + nodeVar87 );
	multiScatteringDielectric = nodeVar88;
	nodeVar89 = dot( normalView, positionViewDirection );
	nodeVar90 = textureSample( nodeUniform15, nodeUniform15_sampler, vec2<f32>( Roughness, clamp( nodeVar89, 0.0, 1.0 ) ) );
	nodeVar91 = ( DiffuseColor.xyz * vec3<f32>( nodeVar90.xy.x ) );
	nodeVar92 = ( SpecularF90 * nodeVar90.xy.y );
	nodeVar93 = ( nodeVar91 + vec3<f32>( nodeVar92 ) );
	nodeVar94 = ( singleScatteringMetallic + nodeVar93 );
	singleScatteringMetallic = nodeVar94;
	nodeVar95 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar96 = nodeVar95;
	nodeVar97 = ( nodeVar96 * vec3<f32>( 0.047619 ) );
	nodeVar98 = ( DiffuseColor.xyz + nodeVar97 );
	nodeVar99 = ( nodeVar93 * nodeVar98 );
	nodeVar100 = ( nodeVar90.xy.x + nodeVar90.xy.y );
	nodeVar101 = ( 1.0 - nodeVar100 );
	nodeVar102 = nodeVar101;
	nodeVar103 = ( vec3<f32>( nodeVar102 ) * nodeVar98 );
	nodeVar104 = ( vec3<f32>( 1.0 ) - nodeVar103 );
	nodeVar105 = nodeVar104;
	nodeVar106 = ( nodeVar99 / nodeVar105 );
	nodeVar107 = ( nodeVar106 * vec3<f32>( nodeVar102 ) );
	nodeVar108 = ( multiScatteringMetallic + nodeVar107 );
	multiScatteringMetallic = nodeVar108;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar109 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar110 = ( radiance * nodeVar109 );
	nodeVar111 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar112 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar113 = ( nodeVar111 * nodeVar112 );
	nodeVar114 = ( nodeVar110 + nodeVar113 );
	nodeVar115 = nodeVar114;
	nodeVar116 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar117 = ( vec3<f32>( 1.0 ) - nodeVar116 );
	nodeVar118 = nodeVar117;
	nodeVar119 = ( DiffuseContribution * nodeVar118 );
	nodeVar120 = ( nodeVar119 * nodeVar112 );
	nodeVar121 = nodeVar120;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar122 = ( indirectSpecular + nodeVar115 );
	indirectSpecular = nodeVar122;
	nodeVar123 = ( indirectDiffuse + nodeVar121 );
	indirectDiffuse = nodeVar123;
	ambientOcclusion = 1.0;
	nodeVar124 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar124;
	nodeVar125 = dot( normalView, positionViewDirection );
	nodeVar126 = ( clamp( nodeVar125, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar127 = ( Roughness * -16.0 );
	nodeVar128 = ( 1.0 - nodeVar127 );
	nodeVar129 = nodeVar128;
	nodeVar130 = ( - nodeVar129 );
	nodeVar131 = exp2( nodeVar130 );
	nodeVar132 = pow( nodeVar126, nodeVar131 );
	nodeVar133 = ( 1.0 - nodeVar132 );
	nodeVar134 = nodeVar133;
	nodeVar135 = ( ambientOcclusion - nodeVar134 );
	nodeVar136 = ( indirectSpecular * vec3<f32>( clamp( nodeVar135, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar136;
	nodeVar137 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar137;
	nodeVar138 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar138;
	nodeVar139 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar139;
	nodeVar140 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar140;

	// result

	output.color = nodeVar140;

	return output;

}
