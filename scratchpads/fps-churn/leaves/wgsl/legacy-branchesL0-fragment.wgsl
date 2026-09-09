// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 2 ) @group( 1 ) var nodeUniform17_sampler : sampler;
@binding( 3 ) @group( 1 ) var nodeUniform17 : texture_2d<f32>;

struct NodeBuffer_5504Struct {
	value : array< vec4<f32> >
};
@binding( 1 ) @group( 1 )
var<storage, read> NodeBuffer_5504 : NodeBuffer_5504Struct;

struct objectStruct {
	nodeUniform1 : u32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform7 : mat3x3<f32>,
	nodeUniform8 : vec3<f32>,
	nodeUniform9 : f32,
	nodeUniform11 : u32,
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
var<private> normalLocal : vec3<f32>;
var<private> nodeVar42 : f32;
var<private> nodeVar43 : f32;
var<private> normalView : vec3<f32>;
var<private> nodeVar44 : vec3<f32>;
var<private> nodeVar45 : vec4<f32>;
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec3<f32>;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : f32;
var<private> nodeVar50 : vec3<f32>;
var<private> nodeVar51 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar52 : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar55 : vec3<f32>;
var<private> nodeVar56 : f32;
var<private> nodeVar57 : f32;
var<private> nodeVar58 : f32;
var<private> nodeVar59 : vec4<f32>;
var<private> nodeVar60 : vec4<f32>;
var<private> nodeVar61 : vec3<f32>;
var<private> nodeVar62 : f32;
var<private> nodeVar63 : f32;
var<private> nodeVar64 : vec3<f32>;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
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
var<private> nodeVar91 : f32;
var<private> nodeVar92 : vec4<f32>;
var<private> nodeVar93 : vec3<f32>;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : vec3<f32>;
var<private> nodeVar96 : vec3<f32>;
var<private> nodeVar97 : vec3<f32>;
var<private> nodeVar98 : vec3<f32>;
var<private> nodeVar99 : vec3<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : vec3<f32>;
var<private> nodeVar102 : f32;
var<private> nodeVar103 : f32;
var<private> nodeVar104 : f32;
var<private> nodeVar105 : vec3<f32>;
var<private> nodeVar106 : vec3<f32>;
var<private> nodeVar107 : vec3<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : vec3<f32>;
var<private> nodeVar113 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar114 : vec3<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec3<f32>;
var<private> nodeVar120 : vec3<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar126 : vec3<f32>;
var<private> nodeVar127 : f32;
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
var<private> nodeVar138 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar140 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar141 : vec3<f32>;
var<private> nodeVar142 : vec4<f32>;

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
	@location( 1 ) v_positionViewDirection : vec3<f32>,
	@location( 2 ) nodeVarying6 : vec3<f32>,
	@location( 3 ) nodeVarying7 : vec2<f32>,
	@location( 4 ) nodeVarying8 : vec3<f32>,
	@location( 5 ) @interpolate(flat, either) nodeVarying9 : u32 ) -> OutputStruct {

	// flow
	// code

	nodeVar4 = vec2<f32>( ( nodeVarying7.x * 7.0 ), ( nodeVarying7.y * 1.35 ) );
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
	nodeVar17 = vec2<f32>( ( ( nodeVarying7.x * 16.0 ) + ( nodeVar16 * 2.0 ) ), ( nodeVarying7.y * 5.5 ) );
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
	nodeVar29 = vec2<f32>( ( nodeVarying7.x * 54.0 ), ( nodeVarying7.y * 18.0 ) );
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
	DiffuseColor = ( vec4<f32>( ( nodeVarying6 * vec3<f32>( mix( 0.48, 1.34, ( ( ( ( ( sin( ( ( ( nodeVarying7.x * 42.0 ) + ( nodeVar16 * 7.0 ) ) + ( mix( mix( fract( ( nodeVar20.x * nodeVar20.y ) ), fract( ( nodeVar22.x * nodeVar22.y ) ), nodeVar24.x ), mix( fract( ( nodeVar26.x * nodeVar26.y ) ), fract( ( nodeVar28.x * nodeVar28.y ) ), nodeVar24.x ), nodeVar24.y ) * 2.5 ) ) ) * 0.5 ) + 0.5 ) * 0.5 ) + ( nodeVar16 * 0.28 ) ) + ( mix( mix( fract( ( nodeVar32.x * nodeVar32.y ) ), fract( ( nodeVar34.x * nodeVar34.y ) ), nodeVar36.x ), mix( fract( ( nodeVar38.x * nodeVar38.y ) ), fract( ( nodeVar40.x * nodeVar40.y ) ), nodeVar36.x ), nodeVar36.y ) * 0.22 ) ) ) ) ), 1.0 ) * vec4<f32>( nodeVarying6, 1.0 ) );
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
	normalLocal = nodeVarying8;
	nodeVar42 = cos( NodeBuffer_5504.value[ ( ( ( object.nodeUniform11 + nodeVarying9 ) * 2u ) + 1u ) ].x );
	nodeVar43 = sin( NodeBuffer_5504.value[ ( ( ( object.nodeUniform11 + nodeVarying9 ) * 2u ) + 1u ) ].x );
	normalView = vec3<f32>( ( ( normalLocal.x * nodeVar42 ) + ( normalLocal.z * nodeVar43 ) ), normalLocal.y, ( ( normalLocal.z * nodeVar42 ) - ( normalLocal.x * nodeVar43 ) ) );
	nodeVar44 = ( render.nodeUniform13 - render.nodeUniform14 );
	nodeVar45 = vec4<f32>( nodeVar44, 0.0 );
	nodeVar46 = ( render.cameraViewMatrix * nodeVar45 );
	nodeVar47 = normalize( nodeVar46.xyz );
	nodeVar48 = nodeVar47;
	nodeVar49 = dot( normalView, nodeVar48 );
	nodeVar50 = ( vec3<f32>( clamp( nodeVar49, 0.0, 1.0 ) ) * render.nodeUniform15 );
	nodeVar51 = nodeVar50;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar52 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar53 = ( nodeVar51 * nodeVar52 );
	nodeVar54 = ( directDiffuse + nodeVar53 );
	directDiffuse = nodeVar54;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar55 = normalize( ( nodeVar48 + positionViewDirection ) );
	nodeVar56 = clamp( dot( positionViewDirection, nodeVar55 ), 0.0, 1.0 );
	nodeVar57 = exp2( ( ( ( nodeVar56 * -5.55473 ) - 6.98316 ) * nodeVar56 ) );
	nodeVar58 = ( Roughness * Roughness );
	nodeVar59 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar60 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar48 ), 0.0, 1.0 ) ) );
	nodeVar61 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar62 = ( 1.0 - ( nodeVar59.xy.x + nodeVar59.xy.y ) );
	nodeVar63 = ( 1.0 - ( nodeVar60.xy.x + nodeVar60.xy.y ) );
	nodeVar64 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar57 ) ) ) + vec3<f32>( ( 1.0 * nodeVar57 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar58, clamp( dot( normalView, nodeVar48 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar58, clamp( dot( normalView, nodeVar55 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar59.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar59.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar60.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar60.xy.y ) ) ) ) * nodeVar61 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar62 * nodeVar63 ) ) * nodeVar61 ) * nodeVar61 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar62 * nodeVar63 ) ) ) );
	nodeVar65 = ( nodeVar51 * nodeVar64 );
	nodeVar66 = ( directSpecular + nodeVar65 );
	directSpecular = nodeVar66;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar67 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar68 = ( irradiance * nodeVar67 );
	nodeVar69 = nodeVar68;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar70 = ( indirectDiffuse + nodeVar69 );
	indirectDiffuse = nodeVar70;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar71 = dot( normalView, positionViewDirection );
	nodeVar72 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar71, 0.0, 1.0 ) ) );
	nodeVar73 = ( SpecularColor * vec3<f32>( nodeVar72.xy.x ) );
	nodeVar74 = ( SpecularF90 * nodeVar72.xy.y );
	nodeVar75 = ( nodeVar73 + vec3<f32>( nodeVar74 ) );
	nodeVar76 = ( singleScatteringDielectric + nodeVar75 );
	singleScatteringDielectric = nodeVar76;
	nodeVar77 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar78 = nodeVar77;
	nodeVar79 = ( nodeVar78 * vec3<f32>( 0.047619 ) );
	nodeVar80 = ( SpecularColor + nodeVar79 );
	nodeVar81 = ( nodeVar75 * nodeVar80 );
	nodeVar82 = ( nodeVar72.xy.x + nodeVar72.xy.y );
	nodeVar83 = ( 1.0 - nodeVar82 );
	nodeVar84 = nodeVar83;
	nodeVar85 = ( vec3<f32>( nodeVar84 ) * nodeVar80 );
	nodeVar86 = ( vec3<f32>( 1.0 ) - nodeVar85 );
	nodeVar87 = nodeVar86;
	nodeVar88 = ( nodeVar81 / nodeVar87 );
	nodeVar89 = ( nodeVar88 * vec3<f32>( nodeVar84 ) );
	nodeVar90 = ( multiScatteringDielectric + nodeVar89 );
	multiScatteringDielectric = nodeVar90;
	nodeVar91 = dot( normalView, positionViewDirection );
	nodeVar92 = textureSample( nodeUniform17, nodeUniform17_sampler, vec2<f32>( Roughness, clamp( nodeVar91, 0.0, 1.0 ) ) );
	nodeVar93 = ( DiffuseColor.xyz * vec3<f32>( nodeVar92.xy.x ) );
	nodeVar94 = ( SpecularF90 * nodeVar92.xy.y );
	nodeVar95 = ( nodeVar93 + vec3<f32>( nodeVar94 ) );
	nodeVar96 = ( singleScatteringMetallic + nodeVar95 );
	singleScatteringMetallic = nodeVar96;
	nodeVar97 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar98 = nodeVar97;
	nodeVar99 = ( nodeVar98 * vec3<f32>( 0.047619 ) );
	nodeVar100 = ( DiffuseColor.xyz + nodeVar99 );
	nodeVar101 = ( nodeVar95 * nodeVar100 );
	nodeVar102 = ( nodeVar92.xy.x + nodeVar92.xy.y );
	nodeVar103 = ( 1.0 - nodeVar102 );
	nodeVar104 = nodeVar103;
	nodeVar105 = ( vec3<f32>( nodeVar104 ) * nodeVar100 );
	nodeVar106 = ( vec3<f32>( 1.0 ) - nodeVar105 );
	nodeVar107 = nodeVar106;
	nodeVar108 = ( nodeVar101 / nodeVar107 );
	nodeVar109 = ( nodeVar108 * vec3<f32>( nodeVar104 ) );
	nodeVar110 = ( multiScatteringMetallic + nodeVar109 );
	multiScatteringMetallic = nodeVar110;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar111 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar112 = ( radiance * nodeVar111 );
	nodeVar113 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar114 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar115 = ( nodeVar113 * nodeVar114 );
	nodeVar116 = ( nodeVar112 + nodeVar115 );
	nodeVar117 = nodeVar116;
	nodeVar118 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar119 = ( vec3<f32>( 1.0 ) - nodeVar118 );
	nodeVar120 = nodeVar119;
	nodeVar121 = ( DiffuseContribution * nodeVar120 );
	nodeVar122 = ( nodeVar121 * nodeVar114 );
	nodeVar123 = nodeVar122;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar124 = ( indirectSpecular + nodeVar117 );
	indirectSpecular = nodeVar124;
	nodeVar125 = ( indirectDiffuse + nodeVar123 );
	indirectDiffuse = nodeVar125;
	ambientOcclusion = 1.0;
	nodeVar126 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar126;
	nodeVar127 = dot( normalView, positionViewDirection );
	nodeVar128 = ( clamp( nodeVar127, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar129 = ( Roughness * -16.0 );
	nodeVar130 = ( 1.0 - nodeVar129 );
	nodeVar131 = nodeVar130;
	nodeVar132 = ( - nodeVar131 );
	nodeVar133 = exp2( nodeVar132 );
	nodeVar134 = pow( nodeVar128, nodeVar133 );
	nodeVar135 = ( 1.0 - nodeVar134 );
	nodeVar136 = nodeVar135;
	nodeVar137 = ( ambientOcclusion - nodeVar136 );
	nodeVar138 = ( indirectSpecular * vec3<f32>( clamp( nodeVar137, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar138;
	nodeVar139 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar139;
	nodeVar140 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar140;
	nodeVar141 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar141;
	nodeVar142 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar142;

	// result

	output.color = nodeVar142;

	return output;

}
