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
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : f32;
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
var<private> nodeVar44 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar45 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar46 : vec3<f32>;
var<private> nodeVar47 : vec4<f32>;
var<private> nodeVar48 : vec4<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> nodeVar51 : f32;
var<private> nodeVar52 : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar54 : vec3<f32>;
var<private> nodeVar55 : vec3<f32>;
var<private> nodeVar56 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar57 : vec3<f32>;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : f32;
var<private> nodeVar60 : f32;
var<private> nodeVar61 : vec4<f32>;
var<private> nodeVar62 : vec4<f32>;
var<private> nodeVar63 : vec3<f32>;
var<private> nodeVar64 : f32;
var<private> nodeVar65 : f32;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar73 : f32;
var<private> nodeVar74 : vec4<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : f32;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : f32;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : vec3<f32>;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : vec4<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : f32;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : f32;
var<private> nodeVar105 : f32;
var<private> nodeVar106 : f32;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar128 : vec3<f32>;
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
var<private> nodeVar139 : f32;
var<private> nodeVar140 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar142 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar143 : vec3<f32>;
var<private> nodeVar144 : vec4<f32>;

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

	nodeVar8 = vec2<f32>( ( v_pulledUv.x * 7.0 ), ( v_pulledUv.y * 1.35 ) );
	nodeVar9 = floor( nodeVar8 );
	nodeVar10 = fract( ( nodeVar9 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar11 = ( nodeVar10 + vec2<f32>( dot( nodeVar10, ( nodeVar10 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar12 = fract( ( ( nodeVar9 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar13 = ( nodeVar12 + vec2<f32>( dot( nodeVar12, ( nodeVar12 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar14 = fract( nodeVar8 );
	nodeVar15 = ( ( nodeVar14 * nodeVar14 ) * ( vec2<f32>( 3.0 ) - ( nodeVar14 * vec2<f32>( 2.0 ) ) ) );
	nodeVar16 = fract( ( ( nodeVar9 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar17 = ( nodeVar16 + vec2<f32>( dot( nodeVar16, ( nodeVar16 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar18 = fract( ( ( nodeVar9 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar19 = ( nodeVar18 + vec2<f32>( dot( nodeVar18, ( nodeVar18 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar20 = mix( mix( fract( ( nodeVar11.x * nodeVar11.y ) ), fract( ( nodeVar13.x * nodeVar13.y ) ), nodeVar15.x ), mix( fract( ( nodeVar17.x * nodeVar17.y ) ), fract( ( nodeVar19.x * nodeVar19.y ) ), nodeVar15.x ), nodeVar15.y );
	nodeVar21 = vec2<f32>( ( ( v_pulledUv.x * 16.0 ) + ( nodeVar20 * 2.0 ) ), ( v_pulledUv.y * 5.5 ) );
	nodeVar22 = floor( nodeVar21 );
	nodeVar23 = fract( ( nodeVar22 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar24 = ( nodeVar23 + vec2<f32>( dot( nodeVar23, ( nodeVar23 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar25 = fract( ( ( nodeVar22 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar26 = ( nodeVar25 + vec2<f32>( dot( nodeVar25, ( nodeVar25 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar27 = fract( nodeVar21 );
	nodeVar28 = ( ( nodeVar27 * nodeVar27 ) * ( vec2<f32>( 3.0 ) - ( nodeVar27 * vec2<f32>( 2.0 ) ) ) );
	nodeVar29 = fract( ( ( nodeVar22 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar30 = ( nodeVar29 + vec2<f32>( dot( nodeVar29, ( nodeVar29 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar31 = fract( ( ( nodeVar22 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar32 = ( nodeVar31 + vec2<f32>( dot( nodeVar31, ( nodeVar31 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar33 = vec2<f32>( ( v_pulledUv.x * 54.0 ), ( v_pulledUv.y * 18.0 ) );
	nodeVar34 = floor( nodeVar33 );
	nodeVar35 = fract( ( nodeVar34 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar36 = ( nodeVar35 + vec2<f32>( dot( nodeVar35, ( nodeVar35 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar37 = fract( ( ( nodeVar34 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar38 = ( nodeVar37 + vec2<f32>( dot( nodeVar37, ( nodeVar37 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar39 = fract( nodeVar33 );
	nodeVar40 = ( ( nodeVar39 * nodeVar39 ) * ( vec2<f32>( 3.0 ) - ( nodeVar39 * vec2<f32>( 2.0 ) ) ) );
	nodeVar41 = fract( ( ( nodeVar34 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar42 = ( nodeVar41 + vec2<f32>( dot( nodeVar41, ( nodeVar41 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar43 = fract( ( ( nodeVar34 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar44 = ( nodeVar43 + vec2<f32>( dot( nodeVar43, ( nodeVar43 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = vec4<f32>( ( v_pulledColor * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( v_pulledUv.x * 42.0 ) + ( nodeVar20 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar24.x * nodeVar24.y ) ), fract( ( nodeVar26.x * nodeVar26.y ) ), nodeVar28.x ), mix( fract( ( nodeVar30.x * nodeVar30.y ) ), fract( ( nodeVar32.x * nodeVar32.y ) ), nodeVar28.x ), nodeVar28.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar20 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar36.x * nodeVar36.y ) ), fract( ( nodeVar38.x * nodeVar38.y ) ), nodeVar40.x ), mix( fract( ( nodeVar42.x * nodeVar42.y ) ), fract( ( nodeVar44.x * nodeVar44.y ) ), nodeVar40.x ), nodeVar40.y ) * 0.22 ) ) ) ) ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform5 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform6;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar45 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform7, 0.0525 ) + max( max( nodeVar45.x, nodeVar45.y ), nodeVar45.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform6 ) ) );
	EmissiveColor = ( object.nodeUniform10 * vec3<f32>( object.nodeUniform11 ) );
	normalView = v_pulledNormal;
	nodeVar46 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar47 = vec4<f32>( nodeVar46, 0.0 );
	nodeVar48 = ( render.cameraViewMatrix * nodeVar47 );
	nodeVar49 = normalize( nodeVar48.xyz );
	nodeVar50 = nodeVar49;
	nodeVar51 = dot( normalView, nodeVar50 );
	nodeVar52 = ( vec3<f32>( clamp( nodeVar51, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar53 = nodeVar52;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar54 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar55 = ( nodeVar53 * nodeVar54 );
	nodeVar56 = ( directDiffuse + nodeVar55 );
	directDiffuse = nodeVar56;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar57 = normalize( ( nodeVar50 + positionViewDirection ) );
	nodeVar58 = clamp( dot( positionViewDirection, nodeVar57 ), 0.0, 1.0 );
	nodeVar59 = exp2( ( ( ( nodeVar58 * -5.55473 ) - 6.98316 ) * nodeVar58 ) );
	nodeVar60 = ( Roughness * Roughness );
	nodeVar61 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar62 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar50 ), 0.0, 1.0 ) ) );
	nodeVar63 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar64 = ( 1.0 - ( nodeVar61.xy.x + nodeVar61.xy.y ) );
	nodeVar65 = ( 1.0 - ( nodeVar62.xy.x + nodeVar62.xy.y ) );
	nodeVar66 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar59 ) ) ) + vec3<f32>( ( 1.0 * nodeVar59 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar60, clamp( dot( normalView, nodeVar50 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar60, clamp( dot( normalView, nodeVar57 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar61.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar61.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar62.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar62.xy.y ) ) ) ) * nodeVar63 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar64 * nodeVar65 ) ) * nodeVar63 ) * nodeVar63 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar64 * nodeVar65 ) ) ) );
	nodeVar67 = ( nodeVar53 * nodeVar66 );
	nodeVar68 = ( directSpecular + nodeVar67 );
	directSpecular = nodeVar68;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar69 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar70 = ( irradiance * nodeVar69 );
	nodeVar71 = nodeVar70;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar72 = ( indirectDiffuse + nodeVar71 );
	indirectDiffuse = nodeVar72;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar73 = dot( normalView, positionViewDirection );
	nodeVar74 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar73, 0.0, 1.0 ) ) );
	nodeVar75 = ( SpecularColor * vec3<f32>( nodeVar74.xy.x ) );
	nodeVar76 = ( SpecularF90 * nodeVar74.xy.y );
	nodeVar77 = ( nodeVar75 + vec3<f32>( nodeVar76 ) );
	nodeVar78 = ( singleScatteringDielectric + nodeVar77 );
	singleScatteringDielectric = nodeVar78;
	nodeVar79 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar80 = nodeVar79;
	nodeVar81 = ( nodeVar80 * vec3<f32>( 0.047619 ) );
	nodeVar82 = ( SpecularColor + nodeVar81 );
	nodeVar83 = ( nodeVar77 * nodeVar82 );
	nodeVar84 = ( nodeVar74.xy.x + nodeVar74.xy.y );
	nodeVar85 = ( 1.0 - nodeVar84 );
	nodeVar86 = nodeVar85;
	nodeVar87 = ( vec3<f32>( nodeVar86 ) * nodeVar82 );
	nodeVar88 = ( vec3<f32>( 1.0 ) - nodeVar87 );
	nodeVar89 = nodeVar88;
	nodeVar90 = ( nodeVar83 / nodeVar89 );
	nodeVar91 = ( nodeVar90 * vec3<f32>( nodeVar86 ) );
	nodeVar92 = ( multiScatteringDielectric + nodeVar91 );
	multiScatteringDielectric = nodeVar92;
	nodeVar93 = dot( normalView, positionViewDirection );
	nodeVar94 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar93, 0.0, 1.0 ) ) );
	nodeVar95 = ( DiffuseColor.xyz * vec3<f32>( nodeVar94.xy.x ) );
	nodeVar96 = ( SpecularF90 * nodeVar94.xy.y );
	nodeVar97 = ( nodeVar95 + vec3<f32>( nodeVar96 ) );
	nodeVar98 = ( singleScatteringMetallic + nodeVar97 );
	singleScatteringMetallic = nodeVar98;
	nodeVar99 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar100 = nodeVar99;
	nodeVar101 = ( nodeVar100 * vec3<f32>( 0.047619 ) );
	nodeVar102 = ( DiffuseColor.xyz + nodeVar101 );
	nodeVar103 = ( nodeVar97 * nodeVar102 );
	nodeVar104 = ( nodeVar94.xy.x + nodeVar94.xy.y );
	nodeVar105 = ( 1.0 - nodeVar104 );
	nodeVar106 = nodeVar105;
	nodeVar107 = ( vec3<f32>( nodeVar106 ) * nodeVar102 );
	nodeVar108 = ( vec3<f32>( 1.0 ) - nodeVar107 );
	nodeVar109 = nodeVar108;
	nodeVar110 = ( nodeVar103 / nodeVar109 );
	nodeVar111 = ( nodeVar110 * vec3<f32>( nodeVar106 ) );
	nodeVar112 = ( multiScatteringMetallic + nodeVar111 );
	multiScatteringMetallic = nodeVar112;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar113 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar114 = ( radiance * nodeVar113 );
	nodeVar115 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar116 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar117 = ( nodeVar115 * nodeVar116 );
	nodeVar118 = ( nodeVar114 + nodeVar117 );
	nodeVar119 = nodeVar118;
	nodeVar120 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar121 = ( vec3<f32>( 1.0 ) - nodeVar120 );
	nodeVar122 = nodeVar121;
	nodeVar123 = ( DiffuseContribution * nodeVar122 );
	nodeVar124 = ( nodeVar123 * nodeVar116 );
	nodeVar125 = nodeVar124;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar126 = ( indirectSpecular + nodeVar119 );
	indirectSpecular = nodeVar126;
	nodeVar127 = ( indirectDiffuse + nodeVar125 );
	indirectDiffuse = nodeVar127;
	ambientOcclusion = 1.0;
	nodeVar128 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar128;
	nodeVar129 = dot( normalView, positionViewDirection );
	nodeVar130 = ( clamp( nodeVar129, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar131 = ( Roughness * -16.0 );
	nodeVar132 = ( 1.0 - nodeVar131 );
	nodeVar133 = nodeVar132;
	nodeVar134 = ( - nodeVar133 );
	nodeVar135 = exp2( nodeVar134 );
	nodeVar136 = pow( nodeVar130, nodeVar135 );
	nodeVar137 = ( 1.0 - nodeVar136 );
	nodeVar138 = nodeVar137;
	nodeVar139 = ( ambientOcclusion - nodeVar138 );
	nodeVar140 = ( indirectSpecular * vec3<f32>( clamp( nodeVar139, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar140;
	nodeVar141 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar141;
	nodeVar142 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar142;
	nodeVar143 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar143;
	nodeVar144 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar144;

	// result

	output.color = nodeVar144;

	return output;

}
