// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform30_sampler : sampler;
@binding( 2 ) @group( 1 ) var nodeUniform30 : texture_2d<f32>;
@binding( 4 ) @group( 1 ) var nodeUniform64_sampler : sampler;
@binding( 5 ) @group( 1 ) var nodeUniform64 : texture_2d<f32>;

struct NodeBuffer_1265Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_1265 : NodeBuffer_1265Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : vec2<f32>,
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : vec2<f32>,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : vec2<f32>,
	nodeUniform16 : f32,
	nodeUniform17 : f32,
	nodeUniform18 : f32,
	nodeUniform19 : f32,
	nodeUniform20 : f32,
	nodeUniform21 : f32,
	nodeUniform22 : f32,
	nodeUniform23 : f32,
	nodeUniform24 : vec2<f32>,
	nodeUniform25 : f32,
	nodeUniform26 : f32,
	nodeUniform27 : f32,
	nodeUniform28 : vec3<f32>,
	nodeUniform29 : vec3<f32>,
	nodeUniform31 : f32,
	nodeUniform32 : vec3<f32>,
	nodeUniform33 : f32,
	nodeUniform34 : f32,
	nodeUniform35 : f32,
	nodeUniform37 : vec2<f32>,
	nodeUniform38 : f32,
	nodeUniform39 : f32,
	nodeUniform40 : f32,
	nodeUniform41 : f32,
	nodeUniform42 : f32,
	nodeUniform43 : vec2<f32>,
	nodeUniform44 : f32,
	nodeUniform45 : f32,
	nodeUniform46 : f32,
	nodeUniform47 : f32,
	nodeUniform48 : f32,
	nodeUniform49 : f32,
	nodeUniform50 : f32,
	nodeUniform52 : mat4x4<f32>,
	nodeUniform53 : vec3<f32>,
	nodeUniform54 : f32,
	nodeUniform55 : f32,
	nodeUniform57 : f32,
	nodeUniform58 : f32,
	nodeUniform59 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	cameraPosition : vec3<f32>,
	nodeUniform62 : vec3<f32>,
	nodeUniform60 : vec3<f32>,
	nodeUniform61 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> nodeVar60 : vec4<f32>;
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
var<private> nodeVar71 : vec2<f32>;
var<private> nodeVar72 : vec2<f32>;
var<private> nodeVar73 : f32;
var<private> nodeVar74 : f32;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> normalView : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec4<f32>;
var<private> nodeVar77 : vec4<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : f32;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : f32;
var<private> nodeVar88 : f32;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : vec4<f32>;
var<private> nodeVar91 : vec4<f32>;
var<private> nodeVar92 : vec3<f32>;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
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
var<private> nodeVar122 : f32;
var<private> nodeVar123 : vec4<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : f32;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : vec3<f32>;
var<private> nodeVar128 : vec3<f32>;
var<private> nodeVar129 : vec3<f32>;
var<private> nodeVar130 : vec3<f32>;
var<private> nodeVar131 : vec3<f32>;
var<private> nodeVar132 : vec3<f32>;
var<private> nodeVar133 : f32;
var<private> nodeVar134 : f32;
var<private> nodeVar135 : f32;
var<private> nodeVar136 : vec3<f32>;
var<private> nodeVar137 : vec3<f32>;
var<private> nodeVar138 : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> nodeVar140 : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar142 : vec3<f32>;
var<private> nodeVar143 : vec3<f32>;
var<private> nodeVar144 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar145 : vec3<f32>;
var<private> nodeVar146 : vec3<f32>;
var<private> nodeVar147 : vec3<f32>;
var<private> nodeVar148 : vec3<f32>;
var<private> nodeVar149 : vec3<f32>;
var<private> nodeVar150 : vec3<f32>;
var<private> nodeVar151 : vec3<f32>;
var<private> nodeVar152 : vec3<f32>;
var<private> nodeVar153 : vec3<f32>;
var<private> nodeVar154 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar155 : vec3<f32>;
var<private> nodeVar156 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar157 : vec3<f32>;
var<private> nodeVar158 : f32;
var<private> nodeVar159 : f32;
var<private> nodeVar160 : f32;
var<private> nodeVar161 : f32;
var<private> nodeVar162 : f32;
var<private> nodeVar163 : f32;
var<private> nodeVar164 : f32;
var<private> nodeVar165 : f32;
var<private> nodeVar166 : f32;
var<private> nodeVar167 : f32;
var<private> nodeVar168 : f32;
var<private> nodeVar169 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar170 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar171 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar172 : vec3<f32>;
var<private> nodeVar173 : vec4<f32>;

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

	nodeVar60 = textureSample( nodeUniform30, nodeUniform30_sampler, vec2<f32>( ( ( object.nodeUniform31 + nodeVarying8.x ) / 5.0 ), nodeVarying8.y ) );
	nodeVar61 = ( vec2<f32>( ( NodeBuffer_1265.value[ ( nodeVarying9 * 2u ) ].xyz.x + object.nodeUniform37.x ), ( NodeBuffer_1265.value[ ( nodeVarying9 * 2u ) ].xyz.z + object.nodeUniform37.y ) ) * vec2<f32>( object.nodeUniform38 ) );
	nodeVar62 = floor( nodeVar61 );
	nodeVar63 = fract( ( nodeVar62 * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar64 = ( nodeVar63 + vec2<f32>( dot( nodeVar63, ( nodeVar63 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar65 = fract( ( ( nodeVar62 + vec2<f32>( 1.0, 0.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar66 = ( nodeVar65 + vec2<f32>( dot( nodeVar65, ( nodeVar65 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar67 = fract( nodeVar61 );
	nodeVar68 = ( ( nodeVar67 * nodeVar67 ) * ( vec2<f32>( 3.0 ) - ( nodeVar67 * vec2<f32>( 2.0 ) ) ) );
	nodeVar69 = fract( ( ( nodeVar62 + vec2<f32>( 0.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar70 = ( nodeVar69 + vec2<f32>( dot( nodeVar69, ( nodeVar69 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar71 = fract( ( ( nodeVar62 + vec2<f32>( 1.0, 1.0 ) ) * vec2<f32>( 123.34, 456.21 ) ) );
	nodeVar72 = ( nodeVar71 + vec2<f32>( dot( nodeVar71, ( nodeVar71 + vec2<f32>( 45.32 ) ) ) ) );
	nodeVar73 = ( positionLocal.y / 0.8 );
	nodeVar74 = mix( clamp( ( object.nodeUniform41 * mix( ( 1.0 - smoothstep( 0.0, max( object.nodeUniform42, 0.001 ), nodeVar73 ) ), 1.0, ( clamp( ( ( length( vec2<f32>( ( NodeBuffer_1265.value[ ( nodeVarying9 * 2u ) ].xyz.x - object.nodeUniform43.x ), ( NodeBuffer_1265.value[ ( nodeVarying9 * 2u ) ].xyz.z - object.nodeUniform43.y ) ) ) - object.nodeUniform44 ) / max( ( object.nodeUniform45 - object.nodeUniform44 ), 0.001 ) ), 0.0, 1.0 ) * object.nodeUniform46 ) ) ), 0.0, 1.0 ), 1.0, clamp( object.nodeUniform47, 0.0, 1.0 ) );
	DiffuseColor = vec4<f32>( mix( ( ( ( mix( ( mix( object.nodeUniform28, object.nodeUniform29, nodeVarying7 ) * vec3<f32>( ( 0.4 + ( nodeVar60.x * 0.9999999999999999 ) ) ) ), object.nodeUniform32, ( nodeVar60.y * 0.7 ) ) * vec3<f32>( ( object.nodeUniform33 + object.nodeUniform34 ) ) ) * vec3<f32>( ( 1.0 - ( object.nodeUniform35 * mix( mix( fract( ( nodeVar64.x * nodeVar64.y ) ), fract( ( nodeVar66.x * nodeVar66.y ) ), nodeVar68.x ), mix( fract( ( nodeVar70.x * nodeVar70.y ) ), fract( ( nodeVar72.x * nodeVar72.y ) ), nodeVar68.x ), nodeVar68.y ) ) ) ) ) * vec3<f32>( mix( ( 1.0 - ( object.nodeUniform39 * object.nodeUniform40 ) ), 1.0, smoothstep( 0.0, 0.35, nodeVar73 ) ) ) ), NodeBuffer_1265.value[ ( ( nodeVarying9 * 2u ) + 1u ) ].yzw, nodeVar74 ), 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform48 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform49;
	Roughness = min( ( max( object.nodeUniform50, 0.0525 ) + 0.0 ), 1.0 );
	SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );
	SpecularColorBlended = mix( vec3<f32>( 0.04, 0.04, 0.04 ), DiffuseColor.xyz, Metalness );
	SpecularF90 = 1.0;
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform49 ) ) );
	EmissiveColor = ( ( ( ( ( object.nodeUniform29 * vec3<f32>( pow( clamp( dot( ( - normalize( ( render.cameraPosition - v_positionWorld ) ) ), normalize( object.nodeUniform53 ) ), 0.0, 1.0 ), 2.0 ) ) ) * vec3<f32>( object.nodeUniform54 ) ) * vec3<f32>( object.nodeUniform55 ) ) * vec3<f32>( nodeVar73 ) ) * vec3<f32>( ( 1.0 - clamp( ( object.nodeUniform47 - 1.0 ), 0.0, 1.0 ) ) ) );
	normalView = normalize( mix( normalize( mix( normalize( ( render.cameraViewMatrix * vec4<f32>( vec3<f32>( 0.0, 1.0, 0.0 ), 0.0 ) ).xyz ), ( normalize( ( render.cameraViewMatrix * vec4<f32>( nodeVarying4, 0.0 ) ).xyz ) * vec3<f32>( ( ( f32( isFront ) * 2.0 ) - 1.0 ) ) ), clamp( mix( object.nodeUniform57, object.nodeUniform58, object.nodeUniform59 ), 0.0, 1.0 ) ) ), normalize( ( render.cameraViewMatrix * vec4<f32>( vec3<f32>( 0.0, 1.0, 0.0 ), 0.0 ) ).xyz ), nodeVar74 ) );
	nodeVar75 = ( render.nodeUniform60 - render.nodeUniform61 );
	nodeVar76 = vec4<f32>( nodeVar75, 0.0 );
	nodeVar77 = ( render.cameraViewMatrix * nodeVar76 );
	nodeVar78 = normalize( nodeVar77.xyz );
	nodeVar79 = nodeVar78;
	nodeVar80 = dot( normalView, nodeVar79 );
	nodeVar81 = ( vec3<f32>( clamp( nodeVar80, 0.0, 1.0 ) ) * render.nodeUniform62 );
	nodeVar82 = nodeVar81;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar83 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar84 = ( nodeVar82 * nodeVar83 );
	nodeVar85 = ( directDiffuse + nodeVar84 );
	directDiffuse = nodeVar85;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar86 = normalize( ( nodeVar79 + positionViewDirection ) );
	nodeVar87 = clamp( dot( positionViewDirection, nodeVar86 ), 0.0, 1.0 );
	nodeVar88 = exp2( ( ( ( nodeVar87 * -5.55473 ) - 6.98316 ) * nodeVar87 ) );
	nodeVar89 = ( Roughness * Roughness );
	nodeVar90 = textureSample( nodeUniform64, nodeUniform64_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar91 = textureSample( nodeUniform64, nodeUniform64_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar79 ), 0.0, 1.0 ) ) );
	nodeVar92 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar93 = ( 1.0 - ( nodeVar90.xy.x + nodeVar90.xy.y ) );
	nodeVar94 = ( 1.0 - ( nodeVar91.xy.x + nodeVar91.xy.y ) );
	nodeVar95 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar88 ) ) ) + vec3<f32>( ( 1.0 * nodeVar88 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar89, clamp( dot( normalView, nodeVar79 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar89, clamp( dot( normalView, nodeVar86 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar90.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar90.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar91.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar91.xy.y ) ) ) ) * nodeVar92 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar93 * nodeVar94 ) ) * nodeVar92 ) * nodeVar92 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar93 * nodeVar94 ) ) ) );
	nodeVar96 = ( nodeVar82 * nodeVar95 );
	nodeVar97 = ( directSpecular + nodeVar96 );
	directSpecular = nodeVar97;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar98 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar99 = ( irradiance * nodeVar98 );
	nodeVar100 = nodeVar99;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar101 = ( indirectDiffuse + nodeVar100 );
	indirectDiffuse = nodeVar101;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar102 = dot( normalView, positionViewDirection );
	nodeVar103 = textureSample( nodeUniform64, nodeUniform64_sampler, vec2<f32>( Roughness, clamp( nodeVar102, 0.0, 1.0 ) ) );
	nodeVar104 = ( SpecularColor * vec3<f32>( nodeVar103.xy.x ) );
	nodeVar105 = ( SpecularF90 * nodeVar103.xy.y );
	nodeVar106 = ( nodeVar104 + vec3<f32>( nodeVar105 ) );
	nodeVar107 = ( singleScatteringDielectric + nodeVar106 );
	singleScatteringDielectric = nodeVar107;
	nodeVar108 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar109 = nodeVar108;
	nodeVar110 = ( nodeVar109 * vec3<f32>( 0.047619 ) );
	nodeVar111 = ( SpecularColor + nodeVar110 );
	nodeVar112 = ( nodeVar106 * nodeVar111 );
	nodeVar113 = ( nodeVar103.xy.x + nodeVar103.xy.y );
	nodeVar114 = ( 1.0 - nodeVar113 );
	nodeVar115 = nodeVar114;
	nodeVar116 = ( vec3<f32>( nodeVar115 ) * nodeVar111 );
	nodeVar117 = ( vec3<f32>( 1.0 ) - nodeVar116 );
	nodeVar118 = nodeVar117;
	nodeVar119 = ( nodeVar112 / nodeVar118 );
	nodeVar120 = ( nodeVar119 * vec3<f32>( nodeVar115 ) );
	nodeVar121 = ( multiScatteringDielectric + nodeVar120 );
	multiScatteringDielectric = nodeVar121;
	nodeVar122 = dot( normalView, positionViewDirection );
	nodeVar123 = textureSample( nodeUniform64, nodeUniform64_sampler, vec2<f32>( Roughness, clamp( nodeVar122, 0.0, 1.0 ) ) );
	nodeVar124 = ( DiffuseColor.xyz * vec3<f32>( nodeVar123.xy.x ) );
	nodeVar125 = ( SpecularF90 * nodeVar123.xy.y );
	nodeVar126 = ( nodeVar124 + vec3<f32>( nodeVar125 ) );
	nodeVar127 = ( singleScatteringMetallic + nodeVar126 );
	singleScatteringMetallic = nodeVar127;
	nodeVar128 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar129 = nodeVar128;
	nodeVar130 = ( nodeVar129 * vec3<f32>( 0.047619 ) );
	nodeVar131 = ( DiffuseColor.xyz + nodeVar130 );
	nodeVar132 = ( nodeVar126 * nodeVar131 );
	nodeVar133 = ( nodeVar123.xy.x + nodeVar123.xy.y );
	nodeVar134 = ( 1.0 - nodeVar133 );
	nodeVar135 = nodeVar134;
	nodeVar136 = ( vec3<f32>( nodeVar135 ) * nodeVar131 );
	nodeVar137 = ( vec3<f32>( 1.0 ) - nodeVar136 );
	nodeVar138 = nodeVar137;
	nodeVar139 = ( nodeVar132 / nodeVar138 );
	nodeVar140 = ( nodeVar139 * vec3<f32>( nodeVar135 ) );
	nodeVar141 = ( multiScatteringMetallic + nodeVar140 );
	multiScatteringMetallic = nodeVar141;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar142 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar143 = ( radiance * nodeVar142 );
	nodeVar144 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar145 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar146 = ( nodeVar144 * nodeVar145 );
	nodeVar147 = ( nodeVar143 + nodeVar146 );
	nodeVar148 = nodeVar147;
	nodeVar149 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar150 = ( vec3<f32>( 1.0 ) - nodeVar149 );
	nodeVar151 = nodeVar150;
	nodeVar152 = ( DiffuseContribution * nodeVar151 );
	nodeVar153 = ( nodeVar152 * nodeVar145 );
	nodeVar154 = nodeVar153;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar155 = ( indirectSpecular + nodeVar148 );
	indirectSpecular = nodeVar155;
	nodeVar156 = ( indirectDiffuse + nodeVar154 );
	indirectDiffuse = nodeVar156;
	ambientOcclusion = 1.0;
	nodeVar157 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar157;
	nodeVar158 = dot( normalView, positionViewDirection );
	nodeVar159 = ( clamp( nodeVar158, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar160 = ( Roughness * -16.0 );
	nodeVar161 = ( 1.0 - nodeVar160 );
	nodeVar162 = nodeVar161;
	nodeVar163 = ( - nodeVar162 );
	nodeVar164 = exp2( nodeVar163 );
	nodeVar165 = pow( nodeVar159, nodeVar164 );
	nodeVar166 = ( 1.0 - nodeVar165 );
	nodeVar167 = nodeVar166;
	nodeVar168 = ( ambientOcclusion - nodeVar167 );
	nodeVar169 = ( indirectSpecular * vec3<f32>( clamp( nodeVar168, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar169;
	nodeVar170 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar170;
	nodeVar171 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar171;
	nodeVar172 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar172;
	nodeVar173 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar173;

	// result

	output.color = nodeVar173;

	return output;

}
