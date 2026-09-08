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
var<private> nodeVar29 : f32;
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
var<private> nodeVar45 : vec2<f32>;
var<private> nodeVar46 : vec2<f32>;
var<private> nodeVar47 : vec2<f32>;
var<private> nodeVar48 : vec2<f32>;
var<private> nodeVar49 : vec2<f32>;
var<private> nodeVar50 : vec2<f32>;
var<private> nodeVar51 : vec2<f32>;
var<private> nodeVar52 : vec2<f32>;
var<private> nodeVar53 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar54 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar55 : vec3<f32>;
var<private> nodeVar56 : vec4<f32>;
var<private> nodeVar57 : vec4<f32>;
var<private> nodeVar58 : vec3<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : f32;
var<private> nodeVar61 : vec3<f32>;
var<private> nodeVar62 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar63 : vec3<f32>;
var<private> nodeVar64 : vec3<f32>;
var<private> nodeVar65 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : f32;
var<private> nodeVar68 : f32;
var<private> nodeVar69 : f32;
var<private> nodeVar70 : vec4<f32>;
var<private> nodeVar71 : vec4<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> nodeVar73 : f32;
var<private> nodeVar74 : f32;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar82 : f32;
var<private> nodeVar83 : vec4<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : vec3<f32>;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : f32;
var<private> nodeVar103 : vec4<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : f32;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : f32;
var<private> nodeVar114 : f32;
var<private> nodeVar115 : f32;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : vec3<f32>;
var<private> nodeVar128 : vec3<f32>;
var<private> nodeVar129 : vec3<f32>;
var<private> nodeVar130 : vec3<f32>;
var<private> nodeVar131 : vec3<f32>;
var<private> nodeVar132 : vec3<f32>;
var<private> nodeVar133 : vec3<f32>;
var<private> nodeVar134 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar135 : vec3<f32>;
var<private> nodeVar136 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar137 : vec3<f32>;
var<private> nodeVar138 : f32;
var<private> nodeVar139 : f32;
var<private> nodeVar140 : f32;
var<private> nodeVar141 : f32;
var<private> nodeVar142 : f32;
var<private> nodeVar143 : f32;
var<private> nodeVar144 : f32;
var<private> nodeVar145 : f32;
var<private> nodeVar146 : f32;
var<private> nodeVar147 : f32;
var<private> nodeVar148 : f32;
var<private> nodeVar149 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar150 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar151 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar152 : vec3<f32>;
var<private> nodeVar153 : vec4<f32>;

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

	nodeVar17 = vec2<f32>( ( v_pulledUv.x * 7.0 ), ( v_pulledUv.y * 1.35 ) );
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
	nodeVar29 = mix( mix( fract( ( nodeVar20.x * nodeVar20.y ) ), fract( ( nodeVar22.x * nodeVar22.y ) ), nodeVar24.x ), mix( fract( ( nodeVar26.x * nodeVar26.y ) ), fract( ( nodeVar28.x * nodeVar28.y ) ), nodeVar24.x ), nodeVar24.y );
	nodeVar30 = vec2<f32>( ( ( v_pulledUv.x * 16.0 ) + ( nodeVar29 * 2.0 ) ), ( v_pulledUv.y * 5.5 ) );
	nodeVar31 = floor( nodeVar30 );
	nodeVar32 = fract( ( nodeVar31 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar33 = ( nodeVar32 + vec2<f32>( dot( nodeVar32, ( nodeVar32 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar34 = fract( ( ( nodeVar31 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar35 = ( nodeVar34 + vec2<f32>( dot( nodeVar34, ( nodeVar34 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar36 = fract( nodeVar30 );
	nodeVar37 = ( ( nodeVar36 * nodeVar36 ) * ( vec2<f32>( 3.0 ) - ( nodeVar36 * vec2<f32>( 2.0 ) ) ) );
	nodeVar38 = fract( ( ( nodeVar31 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar39 = ( nodeVar38 + vec2<f32>( dot( nodeVar38, ( nodeVar38 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar40 = fract( ( ( nodeVar31 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar41 = ( nodeVar40 + vec2<f32>( dot( nodeVar40, ( nodeVar40 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar42 = vec2<f32>( ( v_pulledUv.x * 54.0 ), ( v_pulledUv.y * 18.0 ) );
	nodeVar43 = floor( nodeVar42 );
	nodeVar44 = fract( ( nodeVar43 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar45 = ( nodeVar44 + vec2<f32>( dot( nodeVar44, ( nodeVar44 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar46 = fract( ( ( nodeVar43 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar47 = ( nodeVar46 + vec2<f32>( dot( nodeVar46, ( nodeVar46 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar48 = fract( nodeVar42 );
	nodeVar49 = ( ( nodeVar48 * nodeVar48 ) * ( vec2<f32>( 3.0 ) - ( nodeVar48 * vec2<f32>( 2.0 ) ) ) );
	nodeVar50 = fract( ( ( nodeVar43 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar51 = ( nodeVar50 + vec2<f32>( dot( nodeVar50, ( nodeVar50 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar52 = fract( ( ( nodeVar43 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar53 = ( nodeVar52 + vec2<f32>( dot( nodeVar52, ( nodeVar52 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = vec4<f32>( ( v_pulledColor * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( v_pulledUv.x * 42.0 ) + ( nodeVar29 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar33.x * nodeVar33.y ) ), fract( ( nodeVar35.x * nodeVar35.y ) ), nodeVar37.x ), mix( fract( ( nodeVar39.x * nodeVar39.y ) ), fract( ( nodeVar41.x * nodeVar41.y ) ), nodeVar37.x ), nodeVar37.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar29 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar45.x * nodeVar45.y ) ), fract( ( nodeVar47.x * nodeVar47.y ) ), nodeVar49.x ), mix( fract( ( nodeVar51.x * nodeVar51.y ) ), fract( ( nodeVar53.x * nodeVar53.y ) ), nodeVar49.x ), nodeVar49.y ) * 0.22 ) ) ) ) ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform5 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform6;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar54 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform7, 0.0525 ) + max( max( nodeVar54.x, nodeVar54.y ), nodeVar54.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform6 ) ) );
	EmissiveColor = ( object.nodeUniform10 * vec3<f32>( object.nodeUniform11 ) );
	normalView = v_pulledNormal;
	nodeVar55 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar56 = vec4<f32>( nodeVar55, 0.0 );
	nodeVar57 = ( render.cameraViewMatrix * nodeVar56 );
	nodeVar58 = normalize( nodeVar57.xyz );
	nodeVar59 = nodeVar58;
	nodeVar60 = dot( normalView, nodeVar59 );
	nodeVar61 = ( vec3<f32>( clamp( nodeVar60, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar62 = nodeVar61;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar63 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar64 = ( nodeVar62 * nodeVar63 );
	nodeVar65 = ( directDiffuse + nodeVar64 );
	directDiffuse = nodeVar65;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar66 = normalize( ( nodeVar59 + positionViewDirection ) );
	nodeVar67 = clamp( dot( positionViewDirection, nodeVar66 ), 0.0, 1.0 );
	nodeVar68 = exp2( ( ( ( nodeVar67 * -5.55473 ) - 6.98316 ) * nodeVar67 ) );
	nodeVar69 = ( Roughness * Roughness );
	nodeVar70 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar71 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar59 ), 0.0, 1.0 ) ) );
	nodeVar72 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar73 = ( 1.0 - ( nodeVar70.xy.x + nodeVar70.xy.y ) );
	nodeVar74 = ( 1.0 - ( nodeVar71.xy.x + nodeVar71.xy.y ) );
	nodeVar75 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar68 ) ) ) + vec3<f32>( ( 1.0 * nodeVar68 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar69, clamp( dot( normalView, nodeVar59 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar69, clamp( dot( normalView, nodeVar66 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar70.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar70.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar71.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar71.xy.y ) ) ) ) * nodeVar72 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar73 * nodeVar74 ) ) * nodeVar72 ) * nodeVar72 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar73 * nodeVar74 ) ) ) );
	nodeVar76 = ( nodeVar62 * nodeVar75 );
	nodeVar77 = ( directSpecular + nodeVar76 );
	directSpecular = nodeVar77;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar78 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar79 = ( irradiance * nodeVar78 );
	nodeVar80 = nodeVar79;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar81 = ( indirectDiffuse + nodeVar80 );
	indirectDiffuse = nodeVar81;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar82 = dot( normalView, positionViewDirection );
	nodeVar83 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar82, 0.0, 1.0 ) ) );
	nodeVar84 = ( SpecularColor * vec3<f32>( nodeVar83.xy.x ) );
	nodeVar85 = ( SpecularF90 * nodeVar83.xy.y );
	nodeVar86 = ( nodeVar84 + vec3<f32>( nodeVar85 ) );
	nodeVar87 = ( singleScatteringDielectric + nodeVar86 );
	singleScatteringDielectric = nodeVar87;
	nodeVar88 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar89 = nodeVar88;
	nodeVar90 = ( nodeVar89 * vec3<f32>( 0.047619 ) );
	nodeVar91 = ( SpecularColor + nodeVar90 );
	nodeVar92 = ( nodeVar86 * nodeVar91 );
	nodeVar93 = ( nodeVar83.xy.x + nodeVar83.xy.y );
	nodeVar94 = ( 1.0 - nodeVar93 );
	nodeVar95 = nodeVar94;
	nodeVar96 = ( vec3<f32>( nodeVar95 ) * nodeVar91 );
	nodeVar97 = ( vec3<f32>( 1.0 ) - nodeVar96 );
	nodeVar98 = nodeVar97;
	nodeVar99 = ( nodeVar92 / nodeVar98 );
	nodeVar100 = ( nodeVar99 * vec3<f32>( nodeVar95 ) );
	nodeVar101 = ( multiScatteringDielectric + nodeVar100 );
	multiScatteringDielectric = nodeVar101;
	nodeVar102 = dot( normalView, positionViewDirection );
	nodeVar103 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar102, 0.0, 1.0 ) ) );
	nodeVar104 = ( DiffuseColor.xyz * vec3<f32>( nodeVar103.xy.x ) );
	nodeVar105 = ( SpecularF90 * nodeVar103.xy.y );
	nodeVar106 = ( nodeVar104 + vec3<f32>( nodeVar105 ) );
	nodeVar107 = ( singleScatteringMetallic + nodeVar106 );
	singleScatteringMetallic = nodeVar107;
	nodeVar108 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar109 = nodeVar108;
	nodeVar110 = ( nodeVar109 * vec3<f32>( 0.047619 ) );
	nodeVar111 = ( DiffuseColor.xyz + nodeVar110 );
	nodeVar112 = ( nodeVar106 * nodeVar111 );
	nodeVar113 = ( nodeVar103.xy.x + nodeVar103.xy.y );
	nodeVar114 = ( 1.0 - nodeVar113 );
	nodeVar115 = nodeVar114;
	nodeVar116 = ( vec3<f32>( nodeVar115 ) * nodeVar111 );
	nodeVar117 = ( vec3<f32>( 1.0 ) - nodeVar116 );
	nodeVar118 = nodeVar117;
	nodeVar119 = ( nodeVar112 / nodeVar118 );
	nodeVar120 = ( nodeVar119 * vec3<f32>( nodeVar115 ) );
	nodeVar121 = ( multiScatteringMetallic + nodeVar120 );
	multiScatteringMetallic = nodeVar121;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar122 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar123 = ( radiance * nodeVar122 );
	nodeVar124 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar125 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar126 = ( nodeVar124 * nodeVar125 );
	nodeVar127 = ( nodeVar123 + nodeVar126 );
	nodeVar128 = nodeVar127;
	nodeVar129 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar130 = ( vec3<f32>( 1.0 ) - nodeVar129 );
	nodeVar131 = nodeVar130;
	nodeVar132 = ( DiffuseContribution * nodeVar131 );
	nodeVar133 = ( nodeVar132 * nodeVar125 );
	nodeVar134 = nodeVar133;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar135 = ( indirectSpecular + nodeVar128 );
	indirectSpecular = nodeVar135;
	nodeVar136 = ( indirectDiffuse + nodeVar134 );
	indirectDiffuse = nodeVar136;
	ambientOcclusion = 1.0;
	nodeVar137 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar137;
	nodeVar138 = dot( normalView, positionViewDirection );
	nodeVar139 = ( clamp( nodeVar138, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar140 = ( Roughness * -16.0 );
	nodeVar141 = ( 1.0 - nodeVar140 );
	nodeVar142 = nodeVar141;
	nodeVar143 = ( - nodeVar142 );
	nodeVar144 = exp2( nodeVar143 );
	nodeVar145 = pow( nodeVar139, nodeVar144 );
	nodeVar146 = ( 1.0 - nodeVar145 );
	nodeVar147 = nodeVar146;
	nodeVar148 = ( ambientOcclusion - nodeVar147 );
	nodeVar149 = ( indirectSpecular * vec3<f32>( clamp( nodeVar148, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar149;
	nodeVar150 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar150;
	nodeVar151 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar151;
	nodeVar152 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar152;
	nodeVar153 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar153;

	// result

	output.color = nodeVar153;

	return output;

}
