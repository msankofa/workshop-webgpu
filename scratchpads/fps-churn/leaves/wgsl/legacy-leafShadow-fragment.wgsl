// Three.js r184 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 2 ) @group( 1 ) var nodeUniform19_sampler : sampler;
@binding( 3 ) @group( 1 ) var nodeUniform19 : texture_2d<f32>;

struct NodeBuffer_5504Struct {
	value : array< vec4<f32> >
};
@binding( 1 ) @group( 1 )
var<storage, read> NodeBuffer_5504 : NodeBuffer_5504Struct;

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
	nodeUniform13 : u32,
	nodeUniform18 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
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
var<private> normalLocal : vec3<f32>;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> normalView : vec3<f32>;
var<private> nodeVar7 : vec3<f32>;
var<private> nodeVar8 : vec4<f32>;
var<private> nodeVar9 : vec4<f32>;
var<private> nodeVar10 : vec3<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> nodeVar15 : vec3<f32>;
var<private> nodeVar16 : vec3<f32>;
var<private> nodeVar17 : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : f32;
var<private> nodeVar20 : f32;
var<private> nodeVar21 : f32;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec4<f32>;
var<private> nodeVar24 : vec3<f32>;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec3<f32>;
var<private> nodeVar28 : vec3<f32>;
var<private> nodeVar29 : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> nodeVar30 : vec3<f32>;
var<private> nodeVar31 : vec3<f32>;
var<private> nodeVar32 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> nodeVar33 : vec3<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> nodeVar34 : f32;
var<private> nodeVar35 : vec4<f32>;
var<private> nodeVar36 : vec3<f32>;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : vec3<f32>;
var<private> nodeVar39 : vec3<f32>;
var<private> nodeVar40 : vec3<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> nodeVar42 : vec3<f32>;
var<private> nodeVar43 : vec3<f32>;
var<private> nodeVar44 : vec3<f32>;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : f32;
var<private> nodeVar47 : f32;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : vec3<f32>;
var<private> nodeVar51 : vec3<f32>;
var<private> nodeVar52 : vec3<f32>;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : f32;
var<private> nodeVar55 : vec4<f32>;
var<private> nodeVar56 : vec3<f32>;
var<private> nodeVar57 : f32;
var<private> nodeVar58 : vec3<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : vec3<f32>;
var<private> nodeVar61 : vec3<f32>;
var<private> nodeVar62 : vec3<f32>;
var<private> nodeVar63 : vec3<f32>;
var<private> nodeVar64 : vec3<f32>;
var<private> nodeVar65 : f32;
var<private> nodeVar66 : f32;
var<private> nodeVar67 : f32;
var<private> nodeVar68 : vec3<f32>;
var<private> nodeVar69 : vec3<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> nodeVar73 : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar74 : vec3<f32>;
var<private> nodeVar75 : vec3<f32>;
var<private> nodeVar76 : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : vec3<f32>;
var<private> nodeVar82 : vec3<f32>;
var<private> nodeVar83 : vec3<f32>;
var<private> nodeVar84 : vec3<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> nodeVar89 : vec3<f32>;
var<private> nodeVar90 : f32;
var<private> nodeVar91 : f32;
var<private> nodeVar92 : f32;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : f32;
var<private> nodeVar97 : f32;
var<private> nodeVar98 : f32;
var<private> nodeVar99 : f32;
var<private> nodeVar100 : f32;
var<private> nodeVar101 : vec3<f32>;
var<private> totalDiffuse : vec3<f32>;
var<private> nodeVar102 : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> outgoingLight : vec3<f32>;
var<private> nodeVar104 : vec3<f32>;
var<private> nodeVar105 : vec4<f32>;

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
	@location( 2 ) nodeVarying6 : vec4<f32>,
	@location( 3 ) nodeVarying7 : vec3<f32>,
	@location( 4 ) @interpolate(flat, either) nodeVarying8 : u32 ) -> OutputStruct {

	// flow
	// code

	DiffuseColor = ( vec4<f32>( object.nodeUniform4, 1.0 ) * nodeVarying6 );
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
	normalLocal = nodeVarying7;
	nodeVar5 = cos( NodeBuffer_5504.value[ ( ( ( object.nodeUniform13 + nodeVarying8 ) * 2u ) + 1u ) ].x );
	nodeVar6 = sin( NodeBuffer_5504.value[ ( ( ( object.nodeUniform13 + nodeVarying8 ) * 2u ) + 1u ) ].x );
	normalView = vec3<f32>( ( ( normalLocal.x * nodeVar5 ) + ( normalLocal.z * nodeVar6 ) ), normalLocal.y, ( ( normalLocal.z * nodeVar5 ) - ( normalLocal.x * nodeVar6 ) ) );
	nodeVar7 = ( render.nodeUniform15 - render.nodeUniform16 );
	nodeVar8 = vec4<f32>( nodeVar7, 0.0 );
	nodeVar9 = ( render.cameraViewMatrix * nodeVar8 );
	nodeVar10 = normalize( nodeVar9.xyz );
	nodeVar11 = nodeVar10;
	nodeVar12 = dot( normalView, nodeVar11 );
	nodeVar13 = ( vec3<f32>( clamp( nodeVar12, 0.0, 1.0 ) ) * render.nodeUniform17 );
	nodeVar14 = nodeVar13;
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar15 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar16 = ( nodeVar14 * nodeVar15 );
	nodeVar17 = ( directDiffuse + nodeVar16 );
	directDiffuse = nodeVar17;
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar18 = normalize( ( nodeVar11 + positionViewDirection ) );
	nodeVar19 = clamp( dot( positionViewDirection, nodeVar18 ), 0.0, 1.0 );
	nodeVar20 = exp2( ( ( ( nodeVar19 * -5.55473 ) - 6.98316 ) * nodeVar19 ) );
	nodeVar21 = ( Roughness * Roughness );
	nodeVar22 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) );
	nodeVar23 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, nodeVar11 ), 0.0, 1.0 ) ) );
	nodeVar24 = ( SpecularColorBlended + ( ( vec3<f32>( 1.0 ) - SpecularColorBlended ) * vec3<f32>( 0.047619 ) ) );
	nodeVar25 = ( 1.0 - ( nodeVar22.xy.x + nodeVar22.xy.y ) );
	nodeVar26 = ( 1.0 - ( nodeVar23.xy.x + nodeVar23.xy.y ) );
	nodeVar27 = ( ( ( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeVar20 ) ) ) + vec3<f32>( ( 1.0 * nodeVar20 ) ) ) * vec3<f32>( V_GGX_SmithCorrelated( nodeVar21, clamp( dot( normalView, nodeVar11 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( D_GGX( nodeVar21, clamp( dot( normalView, nodeVar18 ), 0.0, 1.0 ) ) ) ) + ( ( ( ( ( ( SpecularColorBlended * vec3<f32>( nodeVar22.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar22.xy.y ) ) ) * ( ( SpecularColorBlended * vec3<f32>( nodeVar23.xy.x ) ) + vec3<f32>( ( 1.0 * nodeVar23.xy.y ) ) ) ) * nodeVar24 ) / ( ( vec3<f32>( 1.0 ) - ( ( vec3<f32>( ( nodeVar25 * nodeVar26 ) ) * nodeVar24 ) * nodeVar24 ) ) + vec3<f32>( 0.000001 ) ) ) * vec3<f32>( ( nodeVar25 * nodeVar26 ) ) ) );
	nodeVar28 = ( nodeVar14 * nodeVar27 );
	nodeVar29 = ( directSpecular + nodeVar28 );
	directSpecular = nodeVar29;
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar30 = ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) );
	nodeVar31 = ( irradiance * nodeVar30 );
	nodeVar32 = nodeVar31;
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar33 = ( indirectDiffuse + nodeVar32 );
	indirectDiffuse = nodeVar33;
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar34 = dot( normalView, positionViewDirection );
	nodeVar35 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar34, 0.0, 1.0 ) ) );
	nodeVar36 = ( SpecularColor * vec3<f32>( nodeVar35.xy.x ) );
	nodeVar37 = ( SpecularF90 * nodeVar35.xy.y );
	nodeVar38 = ( nodeVar36 + vec3<f32>( nodeVar37 ) );
	nodeVar39 = ( singleScatteringDielectric + nodeVar38 );
	singleScatteringDielectric = nodeVar39;
	nodeVar40 = ( vec3<f32>( 1.0 ) - SpecularColor );
	nodeVar41 = nodeVar40;
	nodeVar42 = ( nodeVar41 * vec3<f32>( 0.047619 ) );
	nodeVar43 = ( SpecularColor + nodeVar42 );
	nodeVar44 = ( nodeVar38 * nodeVar43 );
	nodeVar45 = ( nodeVar35.xy.x + nodeVar35.xy.y );
	nodeVar46 = ( 1.0 - nodeVar45 );
	nodeVar47 = nodeVar46;
	nodeVar48 = ( vec3<f32>( nodeVar47 ) * nodeVar43 );
	nodeVar49 = ( vec3<f32>( 1.0 ) - nodeVar48 );
	nodeVar50 = nodeVar49;
	nodeVar51 = ( nodeVar44 / nodeVar50 );
	nodeVar52 = ( nodeVar51 * vec3<f32>( nodeVar47 ) );
	nodeVar53 = ( multiScatteringDielectric + nodeVar52 );
	multiScatteringDielectric = nodeVar53;
	nodeVar54 = dot( normalView, positionViewDirection );
	nodeVar55 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( nodeVar54, 0.0, 1.0 ) ) );
	nodeVar56 = ( DiffuseColor.xyz * vec3<f32>( nodeVar55.xy.x ) );
	nodeVar57 = ( SpecularF90 * nodeVar55.xy.y );
	nodeVar58 = ( nodeVar56 + vec3<f32>( nodeVar57 ) );
	nodeVar59 = ( singleScatteringMetallic + nodeVar58 );
	singleScatteringMetallic = nodeVar59;
	nodeVar60 = ( vec3<f32>( 1.0 ) - DiffuseColor.xyz );
	nodeVar61 = nodeVar60;
	nodeVar62 = ( nodeVar61 * vec3<f32>( 0.047619 ) );
	nodeVar63 = ( DiffuseColor.xyz + nodeVar62 );
	nodeVar64 = ( nodeVar58 * nodeVar63 );
	nodeVar65 = ( nodeVar55.xy.x + nodeVar55.xy.y );
	nodeVar66 = ( 1.0 - nodeVar65 );
	nodeVar67 = nodeVar66;
	nodeVar68 = ( vec3<f32>( nodeVar67 ) * nodeVar63 );
	nodeVar69 = ( vec3<f32>( 1.0 ) - nodeVar68 );
	nodeVar70 = nodeVar69;
	nodeVar71 = ( nodeVar64 / nodeVar70 );
	nodeVar72 = ( nodeVar71 * vec3<f32>( nodeVar67 ) );
	nodeVar73 = ( multiScatteringMetallic + nodeVar72 );
	multiScatteringMetallic = nodeVar73;
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar74 = mix( singleScatteringDielectric, singleScatteringMetallic, Metalness );
	nodeVar75 = ( radiance * nodeVar74 );
	nodeVar76 = mix( multiScatteringDielectric, multiScatteringMetallic, Metalness );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar77 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar78 = ( nodeVar76 * nodeVar77 );
	nodeVar79 = ( nodeVar75 + nodeVar78 );
	nodeVar80 = nodeVar79;
	nodeVar81 = ( singleScatteringDielectric + multiScatteringDielectric );
	nodeVar82 = ( vec3<f32>( 1.0 ) - nodeVar81 );
	nodeVar83 = nodeVar82;
	nodeVar84 = ( DiffuseContribution * nodeVar83 );
	nodeVar85 = ( nodeVar84 * nodeVar77 );
	nodeVar86 = nodeVar85;
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar87 = ( indirectSpecular + nodeVar80 );
	indirectSpecular = nodeVar87;
	nodeVar88 = ( indirectDiffuse + nodeVar86 );
	indirectDiffuse = nodeVar88;
	ambientOcclusion = 1.0;
	nodeVar89 = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = nodeVar89;
	nodeVar90 = dot( normalView, positionViewDirection );
	nodeVar91 = ( clamp( nodeVar90, 0.0, 1.0 ) + ambientOcclusion );
	nodeVar92 = ( Roughness * -16.0 );
	nodeVar93 = ( 1.0 - nodeVar92 );
	nodeVar94 = nodeVar93;
	nodeVar95 = ( - nodeVar94 );
	nodeVar96 = exp2( nodeVar95 );
	nodeVar97 = pow( nodeVar91, nodeVar96 );
	nodeVar98 = ( 1.0 - nodeVar97 );
	nodeVar99 = nodeVar98;
	nodeVar100 = ( ambientOcclusion - nodeVar99 );
	nodeVar101 = ( indirectSpecular * vec3<f32>( clamp( nodeVar100, 0.0, 1.0 ) ) );
	indirectSpecular = nodeVar101;
	nodeVar102 = ( directDiffuse + indirectDiffuse );
	totalDiffuse = nodeVar102;
	nodeVar103 = ( directSpecular + indirectSpecular );
	totalSpecular = nodeVar103;
	nodeVar104 = ( totalDiffuse + totalSpecular );
	outgoingLight = nodeVar104;
	nodeVar105 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeVar105;

	// result

	output.color = nodeVar105;

	return output;

}
