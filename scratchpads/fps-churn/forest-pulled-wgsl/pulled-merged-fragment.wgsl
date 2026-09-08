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
	nodeUniform4 : f32,
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
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec2<f32>;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : vec2<f32>;
var<private> nodeVar14 : vec2<f32>;
var<private> nodeVar15 : vec2<f32>;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec2<f32>;
var<private> nodeVar19 : f32;
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
var<private> nodeVar41 : vec2<f32>;
var<private> nodeVar42 : vec2<f32>;
var<private> nodeVar43 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar44 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar45 : vec3<f32>;
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec4<f32>;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : f32;
var<private> nodeVar51 : vec3<f32>;
var<private> nodeVar52 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : vec3<f32>;
var<private> nodeVar55 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar56 : vec3<f32>;
var<private> nodeVar57 : f32;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : f32;
var<private> nodeVar60 : vec4<f32>;
var<private> nodeVar61 : vec4<f32>;
var<private> nodeVar62 : vec3<f32>;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
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
var<private> nodeVar92 : f32;
var<private> nodeVar93 : vec4<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : f32;
var<private> nodeVar104 : f32;
var<private> nodeVar105 : f32;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> nodeVar126 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar127 : vec3<f32>;
var<private> nodeVar128 : f32;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : f32;
var<private> nodeVar132 : f32;
var<private> nodeVar133 : f32;
var<private> nodeVar134 : f32;
var<private> nodeVar135 : f32;
var<private> nodeVar136 : f32;
var<private> nodeVar137 : f32;
var<private> nodeVar138 : f32;
var<private> nodeVar139 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar140 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar142 : vec3<f32>;
var<private> nodeVar143 : vec4<f32>;

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
fn main( @location( 0 ) v_pulledColor : vec3<f32>,
	@location( 1 ) v_pulledUv : vec2<f32>,
	@location( 2 ) v_normalViewGeometry : vec3<f32>,
	@location( 3 ) v_pulledNormal : vec3<f32>,
	@location( 4 ) v_positionViewDirection : vec3<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar7 = vec2<f32>( ( v_pulledUv.x * 7.0 ), ( v_pulledUv.y * 1.35 ) );
	nodeVar8 = floor( nodeVar7 );
	nodeVar9 = fract( ( nodeVar8 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar10 = ( nodeVar9 + vec2<f32>( dot( nodeVar9, ( nodeVar9 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar11 = fract( ( ( nodeVar8 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar12 = ( nodeVar11 + vec2<f32>( dot( nodeVar11, ( nodeVar11 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar13 = fract( nodeVar7 );
	nodeVar14 = ( ( nodeVar13 * nodeVar13 ) * ( vec2<f32>( 3.0 ) - ( nodeVar13 * vec2<f32>( 2.0 ) ) ) );
	nodeVar15 = fract( ( ( nodeVar8 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar16 = ( nodeVar15 + vec2<f32>( dot( nodeVar15, ( nodeVar15 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar17 = fract( ( ( nodeVar8 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar18 = ( nodeVar17 + vec2<f32>( dot( nodeVar17, ( nodeVar17 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar19 = mix( mix( fract( ( nodeVar10.x * nodeVar10.y ) ), fract( ( nodeVar12.x * nodeVar12.y ) ), nodeVar14.x ), mix( fract( ( nodeVar16.x * nodeVar16.y ) ), fract( ( nodeVar18.x * nodeVar18.y ) ), nodeVar14.x ), nodeVar14.y );
	nodeVar20 = vec2<f32>( ( ( v_pulledUv.x * 16.0 ) + ( nodeVar19 * 2.0 ) ), ( v_pulledUv.y * 5.5 ) );
	nodeVar21 = floor( nodeVar20 );
	nodeVar22 = fract( ( nodeVar21 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar23 = ( nodeVar22 + vec2<f32>( dot( nodeVar22, ( nodeVar22 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar24 = fract( ( ( nodeVar21 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar25 = ( nodeVar24 + vec2<f32>( dot( nodeVar24, ( nodeVar24 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar26 = fract( nodeVar20 );
	nodeVar27 = ( ( nodeVar26 * nodeVar26 ) * ( vec2<f32>( 3.0 ) - ( nodeVar26 * vec2<f32>( 2.0 ) ) ) );
	nodeVar28 = fract( ( ( nodeVar21 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar29 = ( nodeVar28 + vec2<f32>( dot( nodeVar28, ( nodeVar28 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar30 = fract( ( ( nodeVar21 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar31 = ( nodeVar30 + vec2<f32>( dot( nodeVar30, ( nodeVar30 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar32 = vec2<f32>( ( v_pulledUv.x * 54.0 ), ( v_pulledUv.y * 18.0 ) );
	nodeVar33 = floor( nodeVar32 );
	nodeVar34 = fract( ( nodeVar33 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar35 = ( nodeVar34 + vec2<f32>( dot( nodeVar34, ( nodeVar34 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar36 = fract( ( ( nodeVar33 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar37 = ( nodeVar36 + vec2<f32>( dot( nodeVar36, ( nodeVar36 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar38 = fract( nodeVar32 );
	nodeVar39 = ( ( nodeVar38 * nodeVar38 ) * ( vec2<f32>( 3.0 ) - ( nodeVar38 * vec2<f32>( 2.0 ) ) ) );
	nodeVar40 = fract( ( ( nodeVar33 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar41 = ( nodeVar40 + vec2<f32>( dot( nodeVar40, ( nodeVar40 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar42 = fract( ( ( nodeVar33 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar43 = ( nodeVar42 + vec2<f32>( dot( nodeVar42, ( nodeVar42 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = vec4<f32>( ( v_pulledColor * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( v_pulledUv.x * 42.0 ) + ( nodeVar19 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar23.x * nodeVar23.y ) ), fract( ( nodeVar25.x * nodeVar25.y ) ), nodeVar27.x ), mix( fract( ( nodeVar29.x * nodeVar29.y ) ), fract( ( nodeVar31.x * nodeVar31.y ) ), nodeVar27.x ), nodeVar27.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar19 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar35.x * nodeVar35.y ) ), fract( ( nodeVar37.x * nodeVar37.y ) ), nodeVar39.x ), mix( fract( ( nodeVar41.x * nodeVar41.y ) ), fract( ( nodeVar43.x * nodeVar43.y ) ), nodeVar39.x ), nodeVar39.y ) * 0.22 ) ) ) ) ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform5 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform6;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar44 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform7, 0.0525 ) + max( max( nodeVar44.x, nodeVar44.y ), nodeVar44.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform6 ) ) );
	EmissiveColor = ( object.nodeUniform10 * vec3<f32>( object.nodeUniform11 ) );
	normalView = v_pulledNormal;
	nodeVar45 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar46 = vec4<f32>( nodeVar45, 0.0 );
	nodeVar47 = ( render.cameraViewMatrix * nodeVar46 );
	nodeVar48 = normalize( nodeVar47.xyz );
	nodeVar49 = nodeVar48;
	nodeVar50 = dot( normalView, nodeVar49 );
	nodeVar51 = ( vec3<f32>( clamp( nodeVar50, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar52 = nodeVar51;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar53 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar54 = ( nodeVar52 * nodeVar53 );
	nodeVar55 = ( directDiffuse + nodeVar54 );
	directDiffuse = nodeVar55;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar56 = normalize( ( nodeVar49 + positionViewDirection ) );
	nodeVar57 = clamp( dot( positionViewDirection, nodeVar56 ), 0.0, 1.0 );
	nodeVar58 = exp2( ( ( ( nodeVar57 * -5.55473 ) - 6.98316 ) * nodeVar57 ) );
	nodeVar59 = ( Roughness * Roughness );
	nodeVar60 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar61 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar49 ), 0.0, 1.0 ) ) );
	nodeVar62 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar63 = ( 1.0 - ( nodeVar60.xy.x + nodeVar60.xy.y ) );
	nodeVar64 = ( 1.0 - ( nodeVar61.xy.x + nodeVar61.xy.y ) );
	nodeVar65 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar58 ) ) ) + vec3<f32>( ( 1.0 * nodeVar58 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar59, clamp( dot( normalView, nodeVar49 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar59, clamp( dot( normalView, nodeVar56 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar60.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar60.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar61.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar61.xy.y ) ) ) ) * nodeVar62 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar63 * nodeVar64 ) ) * nodeVar62 ) * nodeVar62 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar63 * nodeVar64 ) ) ) );
	nodeVar66 = ( nodeVar52 * nodeVar65 );
	nodeVar67 = ( directSpecular + nodeVar66 );
	directSpecular = nodeVar67;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar68 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar69 = ( irradiance * nodeVar68 );
	nodeVar70 = nodeVar69;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar71 = ( indirectDiffuse + nodeVar70 );
	indirectDiffuse = nodeVar71;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar72 = dot( normalView, positionViewDirection );
	nodeVar73 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar72, 0.0, 1.0 ) ) );
	nodeVar74 = ( SpecularColor * vec3<f32>( nodeVar73.xy.x ) );
	nodeVar75 = ( SpecularF90 * nodeVar73.xy.y );
	nodeVar76 = ( nodeVar74 + vec3<f32>( nodeVar75 ) );
	nodeVar77 = ( singleScatteringDielectric + nodeVar76 );
	singleScatteringDielectric = nodeVar77;
	nodeVar78 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar79 = nodeVar78;
	nodeVar80 = ( nodeVar79 * vec3<f32>( 0.047619 ) );
	nodeVar81 = ( SpecularColor + nodeVar80 );
	nodeVar82 = ( nodeVar76 * nodeVar81 );
	nodeVar83 = ( nodeVar73.xy.x + nodeVar73.xy.y );
	nodeVar84 = ( 1.0 - nodeVar83 );
	nodeVar85 = nodeVar84;
	nodeVar86 = ( vec3<f32>( nodeVar85 ) * nodeVar81 );
	nodeVar87 = ( vec3<f32>( 1.0 ) - nodeVar86 );
	nodeVar88 = nodeVar87;
	nodeVar89 = ( nodeVar82 / nodeVar88 );
	nodeVar90 = ( nodeVar89 * vec3<f32>( nodeVar85 ) );
	nodeVar91 = ( multiScatteringDielectric + nodeVar90 );
	multiScatteringDielectric = nodeVar91;
	nodeVar92 = dot( normalView, positionViewDirection );
	nodeVar93 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar92, 0.0, 1.0 ) ) );
	nodeVar94 = ( DiffuseColor.xyz * vec3<f32>( nodeVar93.xy.x ) );
	nodeVar95 = ( SpecularF90 * nodeVar93.xy.y );
	nodeVar96 = ( nodeVar94 + vec3<f32>( nodeVar95 ) );
	nodeVar97 = ( singleScatteringMetallic + nodeVar96 );
	singleScatteringMetallic = nodeVar97;
	nodeVar98 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar99 = nodeVar98;
	nodeVar100 = ( nodeVar99 * vec3<f32>( 0.047619 ) );
	nodeVar101 = ( DiffuseColor.xyz + nodeVar100 );
	nodeVar102 = ( nodeVar96 * nodeVar101 );
	nodeVar103 = ( nodeVar93.xy.x + nodeVar93.xy.y );
	nodeVar104 = ( 1.0 - nodeVar103 );
	nodeVar105 = nodeVar104;
	nodeVar106 = ( vec3<f32>( nodeVar105 ) * nodeVar101 );
	nodeVar107 = ( vec3<f32>( 1.0 ) - nodeVar106 );
	nodeVar108 = nodeVar107;
	nodeVar109 = ( nodeVar102 / nodeVar108 );
	nodeVar110 = ( nodeVar109 * vec3<f32>( nodeVar105 ) );
	nodeVar111 = ( multiScatteringMetallic + nodeVar110 );
	multiScatteringMetallic = nodeVar111;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar112 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar113 = ( radiance * nodeVar112 );
	nodeVar114 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar115 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar116 = ( nodeVar114 * nodeVar115 );
	nodeVar117 = ( nodeVar113 + nodeVar116 );
	nodeVar118 = nodeVar117;
	nodeVar119 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar120 = ( vec3<f32>( 1.0 ) - nodeVar119 );
	nodeVar121 = nodeVar120;
	nodeVar122 = ( DiffuseContribution * nodeVar121 );
	nodeVar123 = ( nodeVar122 * nodeVar115 );
	nodeVar124 = nodeVar123;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar125 = ( indirectSpecular + nodeVar118 );
	indirectSpecular = nodeVar125;
	nodeVar126 = ( indirectDiffuse + nodeVar124 );
	indirectDiffuse = nodeVar126;
	ambientOcclusion = 1.0;
	nodeVar127 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar127;
	nodeVar128 = dot( normalView, positionViewDirection );
	nodeVar129 = ( clamp( nodeVar128, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar130 = ( Roughness * -16.0 );
	nodeVar131 = ( 1.0 - nodeVar130 );
	nodeVar132 = nodeVar131;
	nodeVar133 = ( - nodeVar132 );
	nodeVar134 = exp2( nodeVar133 );
	nodeVar135 = pow( nodeVar129, nodeVar134 );
	nodeVar136 = ( 1.0 - nodeVar135 );
	nodeVar137 = nodeVar136;
	nodeVar138 = ( ambientOcclusion - nodeVar137 );
	nodeVar139 = ( indirectSpecular * vec3<f32>( clamp( nodeVar138, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar139;
	nodeVar140 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar140;
	nodeVar141 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar141;
	nodeVar142 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar142;
	nodeVar143 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar143;

	// result

	output.color = nodeVar143;

	return output;

}
