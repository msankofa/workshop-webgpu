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
var<private> nodeVar39 : f32;
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
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : vec2<f32>;
var<private> nodeVar56 : vec2<f32>;
var<private> nodeVar57 : vec2<f32>;
var<private> nodeVar58 : vec2<f32>;
var<private> nodeVar59 : vec2<f32>;
var<private> nodeVar60 : vec2<f32>;
var<private> nodeVar61 : vec2<f32>;
var<private> nodeVar62 : vec2<f32>;
var<private> nodeVar63 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> nodeVar64 : vec3<f32>;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec4<f32>;
var<private> nodeVar69 : vec4<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : f32;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : f32;
var<private> nodeVar80 : f32;
var<private> nodeVar81 : f32;
var<private> nodeVar82 : vec4<f32>;
var<private> nodeVar83 : vec4<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : f32;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar90 : vec3<f32>;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : vec4<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : f32;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : f32;
var<private> nodeVar106 : f32;
var<private> nodeVar107 : f32;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : f32;
var<private> nodeVar115 : vec4<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : f32;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : f32;
var<private> nodeVar126 : f32;
var<private> nodeVar127 : f32;
var<private> nodeVar128 : vec3<f32>;
var<private> nodeVar129 : vec3<f32>;
var<private> nodeVar130 : vec3<f32>;
var<private> nodeVar131 : vec3<f32>;
var<private> nodeVar132 : vec3<f32>;
var<private> nodeVar133 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar134 : vec3<f32>;
var<private> nodeVar135 : vec3<f32>;
var<private> nodeVar136 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar137 : vec3<f32>;
var<private> nodeVar138 : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> nodeVar140 : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> nodeVar142 : vec3<f32>;
var<private> nodeVar143 : vec3<f32>;
var<private> nodeVar144 : vec3<f32>;
var<private> nodeVar145 : vec3<f32>;
var<private> nodeVar146 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar147 : vec3<f32>;
var<private> nodeVar148 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar149 : vec3<f32>;
var<private> nodeVar150 : f32;
var<private> nodeVar151 : f32;
var<private> nodeVar152 : f32;
var<private> nodeVar153 : f32;
var<private> nodeVar154 : f32;
var<private> nodeVar155 : f32;
var<private> nodeVar156 : f32;
var<private> nodeVar157 : f32;
var<private> nodeVar158 : f32;
var<private> nodeVar159 : f32;
var<private> nodeVar160 : f32;
var<private> nodeVar161 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar162 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar163 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar164 : vec3<f32>;
var<private> nodeVar165 : vec4<f32>;

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

	nodeVar27 = vec2<f32>( ( v_pulledUv.x * 7.0 ), ( v_pulledUv.y * 1.35 ) );
	nodeVar28 = floor( nodeVar27 );
	nodeVar29 = fract( ( nodeVar28 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar30 = ( nodeVar29 + vec2<f32>( dot( nodeVar29, ( nodeVar29 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar31 = fract( ( ( nodeVar28 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar32 = ( nodeVar31 + vec2<f32>( dot( nodeVar31, ( nodeVar31 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar33 = fract( nodeVar27 );
	nodeVar34 = ( ( nodeVar33 * nodeVar33 ) * ( vec2<f32>( 3.0 ) - ( nodeVar33 * vec2<f32>( 2.0 ) ) ) );
	nodeVar35 = fract( ( ( nodeVar28 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar36 = ( nodeVar35 + vec2<f32>( dot( nodeVar35, ( nodeVar35 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar37 = fract( ( ( nodeVar28 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar38 = ( nodeVar37 + vec2<f32>( dot( nodeVar37, ( nodeVar37 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar39 = mix( mix( fract( ( nodeVar30.x * nodeVar30.y ) ), fract( ( nodeVar32.x * nodeVar32.y ) ), nodeVar34.x ), mix( fract( ( nodeVar36.x * nodeVar36.y ) ), fract( ( nodeVar38.x * nodeVar38.y ) ), nodeVar34.x ), nodeVar34.y );
	nodeVar40 = vec2<f32>( ( ( v_pulledUv.x * 16.0 ) + ( nodeVar39 * 2.0 ) ), ( v_pulledUv.y * 5.5 ) );
	nodeVar41 = floor( nodeVar40 );
	nodeVar42 = fract( ( nodeVar41 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar43 = ( nodeVar42 + vec2<f32>( dot( nodeVar42, ( nodeVar42 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar44 = fract( ( ( nodeVar41 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar45 = ( nodeVar44 + vec2<f32>( dot( nodeVar44, ( nodeVar44 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar46 = fract( nodeVar40 );
	nodeVar47 = ( ( nodeVar46 * nodeVar46 ) * ( vec2<f32>( 3.0 ) - ( nodeVar46 * vec2<f32>( 2.0 ) ) ) );
	nodeVar48 = fract( ( ( nodeVar41 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar49 = ( nodeVar48 + vec2<f32>( dot( nodeVar48, ( nodeVar48 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar50 = fract( ( ( nodeVar41 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar51 = ( nodeVar50 + vec2<f32>( dot( nodeVar50, ( nodeVar50 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar52 = vec2<f32>( ( v_pulledUv.x * 54.0 ), ( v_pulledUv.y * 18.0 ) );
	nodeVar53 = floor( nodeVar52 );
	nodeVar54 = fract( ( nodeVar53 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar55 = ( nodeVar54 + vec2<f32>( dot( nodeVar54, ( nodeVar54 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar56 = fract( ( ( nodeVar53 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar57 = ( nodeVar56 + vec2<f32>( dot( nodeVar56, ( nodeVar56 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar58 = fract( nodeVar52 );
	nodeVar59 = ( ( nodeVar58 * nodeVar58 ) * ( vec2<f32>( 3.0 ) - ( nodeVar58 * vec2<f32>( 2.0 ) ) ) );
	nodeVar60 = fract( ( ( nodeVar53 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar61 = ( nodeVar60 + vec2<f32>( dot( nodeVar60, ( nodeVar60 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar62 = fract( ( ( nodeVar53 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar63 = ( nodeVar62 + vec2<f32>( dot( nodeVar62, ( nodeVar62 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = vec4<f32>( ( v_pulledColor * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( v_pulledUv.x * 42.0 ) + ( nodeVar39 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar43.x * nodeVar43.y ) ), fract( ( nodeVar45.x * nodeVar45.y ) ), nodeVar47.x ), mix( fract( ( nodeVar49.x * nodeVar49.y ) ), fract( ( nodeVar51.x * nodeVar51.y ) ), nodeVar47.x ), nodeVar47.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar39 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar55.x * nodeVar55.y ) ), fract( ( nodeVar57.x * nodeVar57.y ) ), nodeVar59.x ), mix( fract( ( nodeVar61.x * nodeVar61.y ) ), fract( ( nodeVar63.x * nodeVar63.y ) ), nodeVar59.x ), nodeVar59.y ) * 0.22 ) ) ) ) ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform5 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform6;
	normalViewGeometry = normalize( v_normalViewGeometry );
	nodeVar64 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform7, 0.0525 ) + max( max( nodeVar64.x, nodeVar64.y ), nodeVar64.z ) ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform6 ) ) );
	EmissiveColor = ( object.nodeUniform10 * vec3<f32>( object.nodeUniform11 ) );
	normalView = v_pulledNormal;
	nodeVar67 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar68 = vec4<f32>( nodeVar67, 0.0 );
	nodeVar69 = ( render.cameraViewMatrix * nodeVar68 );
	nodeVar70 = normalize( nodeVar69.xyz );
	nodeVar71 = nodeVar70;
	nodeVar72 = dot( normalView, nodeVar71 );
	nodeVar73 = ( vec3<f32>( clamp( nodeVar72, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar74 = nodeVar73;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar75 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar76 = ( nodeVar74 * nodeVar75 );
	nodeVar77 = ( directDiffuse + nodeVar76 );
	directDiffuse = nodeVar77;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar78 = normalize( ( nodeVar71 + positionViewDirection ) );
	nodeVar79 = clamp( dot( positionViewDirection, nodeVar78 ), 0.0, 1.0 );
	nodeVar80 = exp2( ( ( ( nodeVar79 * -5.55473 ) - 6.98316 ) * nodeVar79 ) );
	nodeVar81 = ( Roughness * Roughness );
	nodeVar82 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar83 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar71 ), 0.0, 1.0 ) ) );
	nodeVar84 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar85 = ( 1.0 - ( nodeVar82.xy.x + nodeVar82.xy.y ) );
	nodeVar86 = ( 1.0 - ( nodeVar83.xy.x + nodeVar83.xy.y ) );
	nodeVar87 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar80 ) ) ) + vec3<f32>( ( 1.0 * nodeVar80 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar81, clamp( dot( normalView, nodeVar71 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar81, clamp( dot( normalView, nodeVar78 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar82.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar82.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar83.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar83.xy.y ) ) ) ) * nodeVar84 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar85 * nodeVar86 ) ) * nodeVar84 ) * nodeVar84 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar85 * nodeVar86 ) ) ) );
	nodeVar88 = ( nodeVar74 * nodeVar87 );
	nodeVar89 = ( directSpecular + nodeVar88 );
	directSpecular = nodeVar89;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar90 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar91 = ( irradiance * nodeVar90 );
	nodeVar92 = nodeVar91;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar93 = ( indirectDiffuse + nodeVar92 );
	indirectDiffuse = nodeVar93;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar94 = dot( normalView, positionViewDirection );
	nodeVar95 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar94, 0.0, 1.0 ) ) );
	nodeVar96 = ( SpecularColor * vec3<f32>( nodeVar95.xy.x ) );
	nodeVar97 = ( SpecularF90 * nodeVar95.xy.y );
	nodeVar98 = ( nodeVar96 + vec3<f32>( nodeVar97 ) );
	nodeVar99 = ( singleScatteringDielectric + nodeVar98 );
	singleScatteringDielectric = nodeVar99;
	nodeVar100 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar101 = nodeVar100;
	nodeVar102 = ( nodeVar101 * vec3<f32>( 0.047619 ) );
	nodeVar103 = ( SpecularColor + nodeVar102 );
	nodeVar104 = ( nodeVar98 * nodeVar103 );
	nodeVar105 = ( nodeVar95.xy.x + nodeVar95.xy.y );
	nodeVar106 = ( 1.0 - nodeVar105 );
	nodeVar107 = nodeVar106;
	nodeVar108 = ( vec3<f32>( nodeVar107 ) * nodeVar103 );
	nodeVar109 = ( vec3<f32>( 1.0 ) - nodeVar108 );
	nodeVar110 = nodeVar109;
	nodeVar111 = ( nodeVar104 / nodeVar110 );
	nodeVar112 = ( nodeVar111 * vec3<f32>( nodeVar107 ) );
	nodeVar113 = ( multiScatteringDielectric + nodeVar112 );
	multiScatteringDielectric = nodeVar113;
	nodeVar114 = dot( normalView, positionViewDirection );
	nodeVar115 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar114, 0.0, 1.0 ) ) );
	nodeVar116 = ( DiffuseColor.xyz * vec3<f32>( nodeVar115.xy.x ) );
	nodeVar117 = ( SpecularF90 * nodeVar115.xy.y );
	nodeVar118 = ( nodeVar116 + vec3<f32>( nodeVar117 ) );
	nodeVar119 = ( singleScatteringMetallic + nodeVar118 );
	singleScatteringMetallic = nodeVar119;
	nodeVar120 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar121 = nodeVar120;
	nodeVar122 = ( nodeVar121 * vec3<f32>( 0.047619 ) );
	nodeVar123 = ( DiffuseColor.xyz + nodeVar122 );
	nodeVar124 = ( nodeVar118 * nodeVar123 );
	nodeVar125 = ( nodeVar115.xy.x + nodeVar115.xy.y );
	nodeVar126 = ( 1.0 - nodeVar125 );
	nodeVar127 = nodeVar126;
	nodeVar128 = ( vec3<f32>( nodeVar127 ) * nodeVar123 );
	nodeVar129 = ( vec3<f32>( 1.0 ) - nodeVar128 );
	nodeVar130 = nodeVar129;
	nodeVar131 = ( nodeVar124 / nodeVar130 );
	nodeVar132 = ( nodeVar131 * vec3<f32>( nodeVar127 ) );
	nodeVar133 = ( multiScatteringMetallic + nodeVar132 );
	multiScatteringMetallic = nodeVar133;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar134 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar135 = ( radiance * nodeVar134 );
	nodeVar136 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar137 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar138 = ( nodeVar136 * nodeVar137 );
	nodeVar139 = ( nodeVar135 + nodeVar138 );
	nodeVar140 = nodeVar139;
	nodeVar141 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar142 = ( vec3<f32>( 1.0 ) - nodeVar141 );
	nodeVar143 = nodeVar142;
	nodeVar144 = ( DiffuseContribution * nodeVar143 );
	nodeVar145 = ( nodeVar144 * nodeVar137 );
	nodeVar146 = nodeVar145;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar147 = ( indirectSpecular + nodeVar140 );
	indirectSpecular = nodeVar147;
	nodeVar148 = ( indirectDiffuse + nodeVar146 );
	indirectDiffuse = nodeVar148;
	ambientOcclusion = 1.0;
	nodeVar149 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar149;
	nodeVar150 = dot( normalView, positionViewDirection );
	nodeVar151 = ( clamp( nodeVar150, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar152 = ( Roughness * -16.0 );
	nodeVar153 = ( 1.0 - nodeVar152 );
	nodeVar154 = nodeVar153;
	nodeVar155 = ( - nodeVar154 );
	nodeVar156 = exp2( nodeVar155 );
	nodeVar157 = pow( nodeVar151, nodeVar156 );
	nodeVar158 = ( 1.0 - nodeVar157 );
	nodeVar159 = nodeVar158;
	nodeVar160 = ( ambientOcclusion - nodeVar159 );
	nodeVar161 = ( indirectSpecular * vec3<f32>( clamp( nodeVar160, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar161;
	nodeVar162 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar162;
	nodeVar163 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar163;
	nodeVar164 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar164;
	nodeVar165 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar165;

	// result

	output.color = nodeVar165;

	return output;

}
