// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform22_sampler : sampler;
@binding( 2 ) @group( 1 ) var nodeUniform22 : texture_2d<f32>;
@binding( 4 ) @group( 1 ) var nodeUniform55_sampler : sampler;
@binding( 5 ) @group( 1 ) var nodeUniform55 : texture_2d<f32>;

struct NodeBuffer_1080Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_1080 : NodeBuffer_1080Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : vec2<f32>,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : vec2<f32>,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : f32,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : vec2<f32>,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : vec3<f32>,
	nodeUniform21 : vec3<f32>,
	nodeUniform23 : f32,
	nodeUniform24 : vec3<f32>,
	nodeUniform26 : f32,
	nodeUniform27 : f32,
	nodeUniform28 : vec2<f32>,
	nodeUniform29 : f32,
	nodeUniform30 : f32,
	nodeUniform31 : f32,
	nodeUniform32 : f32,
	nodeUniform33 : f32,
	nodeUniform34 : f32,
	nodeUniform35 : vec2<f32>,
	nodeUniform36 : f32,
	nodeUniform37 : f32,
	nodeUniform38 : f32,
	nodeUniform39 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : f32,
	nodeUniform43 : mat4x4<f32>,
	nodeUniform44 : vec3<f32>,
	nodeUniform45 : f32,
	nodeUniform46 : f32,
	nodeUniform48 : f32,
	nodeUniform49 : f32,
	nodeUniform50 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	cameraPosition : vec3<f32>,
	nodeUniform53 : vec3<f32>,
	nodeUniform51 : vec3<f32>,
	nodeUniform52 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> nodeVar57 : vec4<f32>;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : vec2<f32>;
var<private> nodeVar60 : vec2<f32>;
var<private> nodeVar61 : vec2<f32>;
var<private> nodeVar62 : vec2<f32>;
var<private> nodeVar63 : vec2<f32>;
var<private> nodeVar64 : vec2<f32>;
var<private> nodeVar65 : vec2<f32>;
var<private> nodeVar66 : vec2<f32>;
var<private> nodeVar67 : vec2<f32>;
var<private> nodeVar68 : vec2<f32>;
var<private> nodeVar69 : vec2<f32>;
var<private> nodeVar70 : vec2<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : vec4<f32>;
var<private> nodeVar73 : vec4<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : f32;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : f32;
var<private> nodeVar84 : f32;
var<private> nodeVar85 : f32;
var<private> nodeVar86 : vec4<f32>;
var<private> nodeVar87 : vec4<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : f32;
var<private> nodeVar91 : vec3<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar94 : vec3<f32>;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar98 : f32;
var<private> nodeVar99 : vec4<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : f32;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : vec3<f32>;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : f32;
var<private> nodeVar110 : f32;
var<private> nodeVar111 : f32;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : f32;
var<private> nodeVar119 : vec4<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : f32;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : vec3<f32>;
var<private> nodeVar128 : vec3<f32>;
var<private> nodeVar129 : f32;
var<private> nodeVar130 : f32;
var<private> nodeVar131 : f32;
var<private> nodeVar132 : vec3<f32>;
var<private> nodeVar133 : vec3<f32>;
var<private> nodeVar134 : vec3<f32>;
var<private> nodeVar135 : vec3<f32>;
var<private> nodeVar136 : vec3<f32>;
var<private> nodeVar137 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar138 : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> nodeVar140 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> nodeVar142 : vec3<f32>;
var<private> nodeVar143 : vec3<f32>;
var<private> nodeVar144 : vec3<f32>;
var<private> nodeVar145 : vec3<f32>;
var<private> nodeVar146 : vec3<f32>;
var<private> nodeVar147 : vec3<f32>;
var<private> nodeVar148 : vec3<f32>;
var<private> nodeVar149 : vec3<f32>;
var<private> nodeVar150 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar151 : vec3<f32>;
var<private> nodeVar152 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar153 : vec3<f32>;
var<private> nodeVar154 : f32;
var<private> nodeVar155 : f32;
var<private> nodeVar156 : f32;
var<private> nodeVar157 : f32;
var<private> nodeVar158 : f32;
var<private> nodeVar159 : f32;
var<private> nodeVar160 : f32;
var<private> nodeVar161 : f32;
var<private> nodeVar162 : f32;
var<private> nodeVar163 : f32;
var<private> nodeVar164 : f32;
var<private> nodeVar165 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar166 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar167 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar168 : vec3<f32>;
var<private> nodeVar169 : vec4<f32>;

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
fn main( @location( 0 ) positionLocal : vec3<f32>,
	@location( 1 ) v_positionWorld : vec3<f32>,
	@location( 2 ) nodeVarying4 : vec3<f32>,
	@location( 3 ) v_positionViewDirection : vec3<f32>,
	@location( 4 ) nodeVarying7 : f32,
	@location( 5 ) nodeVarying8 : vec2<f32>,
	@location( 6 ) @interpolate(flat, either) nodeVarying9 : u32,
	@builtin( front_facing ) isFront : bool ) -> OutputStruct {

	// flow
	// code

	nodeVar57 = textureSample( nodeUniform22, nodeUniform22_sampler, vec2<f32>( ( ( object.nodeUniform23 + nodeVarying8.x ) / 5.0 ), nodeVarying8.y ) );
	nodeVar58 = ( positionLocal.y / 0.8 );
	nodeVar59 = ( vec2<f32>( ( NodeBuffer_1080.value[ ( nodeVarying9 * 2u ) ].xyz.x + object.nodeUniform35.x ), ( NodeBuffer_1080.value[ ( nodeVarying9 * 2u ) ].xyz.z + object.nodeUniform35.y ) ) * vec2<f32>( object.nodeUniform36 ) );
	nodeVar60 = floor( nodeVar59 );
	nodeVar61 = fract( ( nodeVar60 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar62 = ( nodeVar61 + vec2<f32>( dot( nodeVar61, ( nodeVar61 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar63 = fract( ( ( nodeVar60 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar64 = ( nodeVar63 + vec2<f32>( dot( nodeVar63, ( nodeVar63 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar65 = fract( nodeVar59 );
	nodeVar66 = ( ( nodeVar65 * nodeVar65 ) * ( vec2<f32>( 3.0 ) - ( nodeVar65 * vec2<f32>( 2.0 ) ) ) );
	nodeVar67 = fract( ( ( nodeVar60 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar68 = ( nodeVar67 + vec2<f32>( dot( nodeVar67, ( nodeVar67 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar69 = fract( ( ( nodeVar60 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar70 = ( nodeVar69 + vec2<f32>( dot( nodeVar69, ( nodeVar69 + vec2<f32>( 45.32 ) ) ) ) );
	DiffuseColor = vec4<f32>( ( ( ( mix( mix( ( mix( object.nodeUniform20, object.nodeUniform21, nodeVarying7 ) * vec3<f32>( ( 0.4 + ( nodeVar57.x * 0.9999999999999999 ) ) ) ), object.nodeUniform24, ( nodeVar57.y * 0.7 ) ), NodeBuffer_1080.value[ ( ( nodeVarying9 * 2u ) + 1u ) ].yzw, clamp( ( object.nodeUniform26 * mix( ( 1.0 - smoothstep( 0.0, max( object.nodeUniform27, 0.001 ), nodeVar58 ) ), 1.0, ( clamp( ( ( length( vec2<f32>( ( NodeBuffer_1080.value[ ( nodeVarying9 * 2u ) ].xyz.x - object.nodeUniform28.x ), ( NodeBuffer_1080.value[ ( nodeVarying9 * 2u ) ].xyz.z - object.nodeUniform28.y ) ) ) - object.nodeUniform29 ) / max( ( object.nodeUniform30 - object.nodeUniform29 ), 0.001 ) ), 0.0, 1.0 ) * object.nodeUniform31 ) ) ), 0.0, 1.0 ) ) * vec3<f32>( ( object.nodeUniform32 + object.nodeUniform33 ) ) ) * vec3<f32>( ( 1.0 - ( object.nodeUniform34 * mix( mix( fract( ( nodeVar62.x * nodeVar62.y ) ), fract( ( nodeVar64.x * nodeVar64.y ) ), nodeVar66.x ), mix( fract( ( nodeVar68.x * nodeVar68.y ) ), fract( ( nodeVar70.x * nodeVar70.y ) ), nodeVar66.x ), nodeVar66.y ) ) ) ) ) * vec3<f32>( mix( ( 1.0 - ( object.nodeUniform37 * object.nodeUniform38 ) ), 1.0, smoothstep( 0.0, 0.35, nodeVar58 ) ) ) ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform39 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform40;
	Roughness = min( ( max( object.nodeUniform41, 0.0525 ) + 0.0 ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform40 ) ) );
	EmissiveColor = ( ( ( ( object.nodeUniform21 * vec3<f32>( pow( clamp( dot( ( - normalize( ( render.cameraPosition - v_positionWorld ) ) ), normalize( object.nodeUniform44 ) ), 0.0, 1.0 ), 2.0 ) ) ) * vec3<f32>( object.nodeUniform45 ) ) * vec3<f32>( object.nodeUniform46 ) ) * vec3<f32>( nodeVar58 ) );
	normalView = normalize( mix( normalize( ( render.cameraViewMatrix * vec4<f32>( vec3<f32>( 0.0, 1.0, 0.0 ), 0.0 ) ).xyz ), ( normalize( ( render.cameraViewMatrix * vec4<f32>( nodeVarying4, 0.0 ) ).xyz ) * vec3<f32>( ( ( f32( isFront ) * 2.0 ) - 1.0 ) ) ), clamp( mix( object.nodeUniform48, object.nodeUniform49, object.nodeUniform50 ), 0.0, 1.0 ) ) );
	nodeVar71 = ( render.nodeUniform51 - render.nodeUniform52 );
	nodeVar72 = vec4<f32>( nodeVar71, 0.0 );
	nodeVar73 = ( render.cameraViewMatrix * nodeVar72 );
	nodeVar74 = normalize( nodeVar73.xyz );
	nodeVar75 = nodeVar74;
	nodeVar76 = dot( normalView, nodeVar75 );
	nodeVar77 = ( vec3<f32>( clamp( nodeVar76, 0.0, 1.0 ) ) * render.nodeUniform53 );
	nodeVar78 = nodeVar77;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar79 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar80 = ( nodeVar78 * nodeVar79 );
	nodeVar81 = ( directDiffuse + nodeVar80 );
	directDiffuse = nodeVar81;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar82 = normalize( ( nodeVar75 + positionViewDirection ) );
	nodeVar83 = clamp( dot( positionViewDirection, nodeVar82 ), 0.0, 1.0 );
	nodeVar84 = exp2( ( ( ( nodeVar83 * -5.55473 ) - 6.98316 ) * nodeVar83 ) );
	nodeVar85 = ( Roughness * Roughness );
	nodeVar86 = textureSample( nodeUniform55, nodeUniform55_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar87 = textureSample( nodeUniform55, nodeUniform55_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar75 ), 0.0, 1.0 ) ) );
	nodeVar88 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar89 = ( 1.0 - ( nodeVar86.xy.x + nodeVar86.xy.y ) );
	nodeVar90 = ( 1.0 - ( nodeVar87.xy.x + nodeVar87.xy.y ) );
	nodeVar91 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar84 ) ) ) + vec3<f32>( ( 1.0 * nodeVar84 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar85, clamp( dot( normalView, nodeVar75 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar85, clamp( dot( normalView, nodeVar82 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar86.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar86.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar87.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar87.xy.y ) ) ) ) * nodeVar88 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar89 * nodeVar90 ) ) * nodeVar88 ) * nodeVar88 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar89 * nodeVar90 ) ) ) );
	nodeVar92 = ( nodeVar78 * nodeVar91 );
	nodeVar93 = ( directSpecular + nodeVar92 );
	directSpecular = nodeVar93;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar94 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar95 = ( irradiance * nodeVar94 );
	nodeVar96 = nodeVar95;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar97 = ( indirectDiffuse + nodeVar96 );
	indirectDiffuse = nodeVar97;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar98 = dot( normalView, positionViewDirection );
	nodeVar99 = textureSample( nodeUniform55, nodeUniform55_sampler, vec2<f32>( Roughness, clamp( nodeVar98, 0.0, 1.0 ) ) );
	nodeVar100 = ( SpecularColor * vec3<f32>( nodeVar99.xy.x ) );
	nodeVar101 = ( SpecularF90 * nodeVar99.xy.y );
	nodeVar102 = ( nodeVar100 + vec3<f32>( nodeVar101 ) );
	nodeVar103 = ( singleScatteringDielectric + nodeVar102 );
	singleScatteringDielectric = nodeVar103;
	nodeVar104 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar105 = nodeVar104;
	nodeVar106 = ( nodeVar105 * vec3<f32>( 0.047619 ) );
	nodeVar107 = ( SpecularColor + nodeVar106 );
	nodeVar108 = ( nodeVar102 * nodeVar107 );
	nodeVar109 = ( nodeVar99.xy.x + nodeVar99.xy.y );
	nodeVar110 = ( 1.0 - nodeVar109 );
	nodeVar111 = nodeVar110;
	nodeVar112 = ( vec3<f32>( nodeVar111 ) * nodeVar107 );
	nodeVar113 = ( vec3<f32>( 1.0 ) - nodeVar112 );
	nodeVar114 = nodeVar113;
	nodeVar115 = ( nodeVar108 / nodeVar114 );
	nodeVar116 = ( nodeVar115 * vec3<f32>( nodeVar111 ) );
	nodeVar117 = ( multiScatteringDielectric + nodeVar116 );
	multiScatteringDielectric = nodeVar117;
	nodeVar118 = dot( normalView, positionViewDirection );
	nodeVar119 = textureSample( nodeUniform55, nodeUniform55_sampler, vec2<f32>( Roughness, clamp( nodeVar118, 0.0, 1.0 ) ) );
	nodeVar120 = ( DiffuseColor.xyz * vec3<f32>( nodeVar119.xy.x ) );
	nodeVar121 = ( SpecularF90 * nodeVar119.xy.y );
	nodeVar122 = ( nodeVar120 + vec3<f32>( nodeVar121 ) );
	nodeVar123 = ( singleScatteringMetallic + nodeVar122 );
	singleScatteringMetallic = nodeVar123;
	nodeVar124 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar125 = nodeVar124;
	nodeVar126 = ( nodeVar125 * vec3<f32>( 0.047619 ) );
	nodeVar127 = ( DiffuseColor.xyz + nodeVar126 );
	nodeVar128 = ( nodeVar122 * nodeVar127 );
	nodeVar129 = ( nodeVar119.xy.x + nodeVar119.xy.y );
	nodeVar130 = ( 1.0 - nodeVar129 );
	nodeVar131 = nodeVar130;
	nodeVar132 = ( vec3<f32>( nodeVar131 ) * nodeVar127 );
	nodeVar133 = ( vec3<f32>( 1.0 ) - nodeVar132 );
	nodeVar134 = nodeVar133;
	nodeVar135 = ( nodeVar128 / nodeVar134 );
	nodeVar136 = ( nodeVar135 * vec3<f32>( nodeVar131 ) );
	nodeVar137 = ( multiScatteringMetallic + nodeVar136 );
	multiScatteringMetallic = nodeVar137;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar138 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar139 = ( radiance * nodeVar138 );
	nodeVar140 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar141 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar142 = ( nodeVar140 * nodeVar141 );
	nodeVar143 = ( nodeVar139 + nodeVar142 );
	nodeVar144 = nodeVar143;
	nodeVar145 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar146 = ( vec3<f32>( 1.0 ) - nodeVar145 );
	nodeVar147 = nodeVar146;
	nodeVar148 = ( DiffuseContribution * nodeVar147 );
	nodeVar149 = ( nodeVar148 * nodeVar141 );
	nodeVar150 = nodeVar149;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar151 = ( indirectSpecular + nodeVar144 );
	indirectSpecular = nodeVar151;
	nodeVar152 = ( indirectDiffuse + nodeVar150 );
	indirectDiffuse = nodeVar152;
	ambientOcclusion = 1.0;
	nodeVar153 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar153;
	nodeVar154 = dot( normalView, positionViewDirection );
	nodeVar155 = ( clamp( nodeVar154, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar156 = ( Roughness * -16.0 );
	nodeVar157 = ( 1.0 - nodeVar156 );
	nodeVar158 = nodeVar157;
	nodeVar159 = ( - nodeVar158 );
	nodeVar160 = exp2( nodeVar159 );
	nodeVar161 = pow( nodeVar155, nodeVar160 );
	nodeVar162 = ( 1.0 - nodeVar161 );
	nodeVar163 = nodeVar162;
	nodeVar164 = ( ambientOcclusion - nodeVar163 );
	nodeVar165 = ( indirectSpecular * vec3<f32>( clamp( nodeVar164, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar165;
	nodeVar166 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar166;
	nodeVar167 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar167;
	nodeVar168 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar168;
	nodeVar169 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar169;

	// result

	output.color = nodeVar169;

	return output;

}
