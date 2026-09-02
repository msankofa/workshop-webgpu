/**
 * Shared implicit-field core for Chrysalis Engine.
 *
 * This module deliberately knows nothing about Three.js, the DOM, GUI controls, or render loops. It
 * harvests and synthesizes field math from three MIT-licensed Sabosugi pens:
 *
 * - Alien Cell: sorted fold tissue, orbit traps, hollow core
 *   https://codepen.io/sabosugi/pen/xbgWxvN
 * - Repo SDF bug: shared beetle shell, head, six legs, eyes, and antennae anatomy
 * - Repo SDF creature (after Drin): alternate shared anatomy
 * - Xenolith Diamond: triangular crystal disturbance applied to that shared anatomy
 *   https://codepen.io/sabosugi/pen/JobXbPW
 * - Abnormal Sphere Morphing: iterative directional warp and value-noise membrane
 *   https://codepen.io/sabosugi/pen/vEyOYEX
 * - The repository's TSL SDF creature (after Drin): shared anatomy for both material phases
 *   ../../demos/sdf-creature.html
 *
 * The output is one distance-like field. Growth changes its coordinate stiffness, silhouette, material
 * phase, and interior density; it is not a mask used only by the final color.
 */

export const CHRYSALIS_MAX_SEEDS = 8;

export const CHRYSALIS_GLSL = /* glsl */ `
  #define CHRYSALIS_MAX_SEEDS 8
  #define CHRYSALIS_CELL_ITERS 7

  uniform float uTime;

  uniform int uAnatomyMode;
  uniform float uBodyRadius;
  uniform float uAnatomyBodyWidth;
  uniform float uAnatomyAppendageLength;
  uniform float uAnatomyEyeSize;
  uniform float uAnatomyLegScale;
  uniform float uOrganicWarpAmp;
  uniform float uOrganicWarpFalloff;
  uniform float uOrganicWarpFrequency;
  uniform float uOrganicWarpVelocity;
  uniform float uOrganicNoiseScale;
  uniform float uOrganicNoiseVelocity;
  uniform float uOrganicRelief;
  uniform float uOrganicPulse;
  uniform float uOrganicPulseFrequency;
  uniform float uOrganicPulseWavelength;
  uniform float uCellStructure;
  uniform float uAlienFoldScale;
  uniform float uAlienFoldRotation;
  uniform float uAlienVeinWidth;
  uniform float uFoldDisplacement;
  uniform float uVeinEmboss;
  uniform float uCoreRadius;

  uniform vec3 uBugAbdomenScale;
  uniform float uBugHeadScale;
  uniform float uBugGrooveDepth;
  uniform float uBugAntennaElevation;
  uniform float uBugAntennaPitch;
  uniform float uBugAntennaThickness;
  uniform vec3 uBugLegSpread;

  uniform float uCrystalScale;
  uniform vec3 uCrystalRotation;
  uniform float uCrystalStiffness;
  uniform float uFacetFrequency;
  uniform float uFacetRelief;
  uniform float uFrontRelief;
  uniform float uLatticeSkew;
  uniform float uLatticeAnisotropy;

  uniform int uSeedCount;
  uniform vec4 uSeedDirRadius[CHRYSALIS_MAX_SEEDS];
  uniform vec4 uSeedMeta[CHRYSALIS_MAX_SEEDS];
  uniform float uGrowthFeather;
  uniform float uVeinAffinity;
  uniform float uGlobalGrowth;

  mat2 chRot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
  }

  float chSmoothMax(float a, float b, float k) {
    float h = clamp(0.5 - 0.5 * (b - a) / max(k, 0.0001), 0.0, 1.0);
    return mix(b, a, h) + k * h * (1.0 - h);
  }

  float chHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.283, 37.919))) * 43758.7053);
  }

  float chValueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = chHash(i);
    float n100 = chHash(i + vec3(1.0, 0.0, 0.0));
    float n010 = chHash(i + vec3(0.0, 1.0, 0.0));
    float n110 = chHash(i + vec3(1.0, 1.0, 0.0));
    float n001 = chHash(i + vec3(0.0, 0.0, 1.0));
    float n101 = chHash(i + vec3(1.0, 0.0, 1.0));
    float n011 = chHash(i + vec3(0.0, 1.0, 1.0));
    float n111 = chHash(i + vec3(1.0));
    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);
    return mix(nx00, nx10, u.y) * (1.0 - u.z) + mix(nx01, nx11, u.y) * u.z;
  }

  // Abnormal Sphere Morphing's iterative directional warp, reduced to six bounded stages so the hybrid
  // can afford to evaluate it inside a surface marcher.
  vec3 chWarpDirection(vec3 direction) {
    vec3 q = direction * 0.4;
    float frequency = uOrganicWarpFrequency;
    float power = pow(max(uOrganicWarpFalloff, 0.55), uOrganicWarpFrequency);
    float phase = uTime * uOrganicWarpVelocity;
    for (int i = 0; i < 6; i++) {
      vec3 offset;
      offset.x = sin(q.y * power + phase + frequency * 0.18);
      offset.y = sin(q.z * power + phase + frequency * 0.21);
      offset.z = sin(q.x * power + phase + frequency * 0.24);
      q += offset * (uOrganicWarpAmp / max(power, 0.35));
      frequency += 1.0;
      power *= max(uOrganicWarpFalloff, 0.55);
    }
    return q;
  }

  void chSortFold(inout vec3 p) {
    p = abs(p);
    if (p.x < p.y) p.xy = p.yx;
    if (p.x < p.z) p.xz = p.zx;
    if (p.y < p.z) p.yz = p.zy;
  }

  // Alien Cell's sorted fold and orbit trap. Creature geometry supplies the macro boundary; this
  // function supplies tissue relief and the channels that steer crystallization.
  vec4 chAlienTissue(vec3 p) {
    p.xz *= chRot(uAlienFoldRotation * 0.08 * sin(uTime * 0.18));
    p.yz *= chRot(uAlienFoldRotation * 0.06 * sin(uTime * 0.13));
    vec3 z = p;
    float scaleTracker = 1.4;
    vec3 trap = vec3(10.0);
    float scale = uAlienFoldScale;
    const vec3 offset = vec3(0.76, 0.70, 0.36);
    for (int i = 0; i < CHRYSALIS_CELL_ITERS; i++) {
      chSortFold(z);
      z.xy *= chRot(0.65539816339 * uAlienFoldRotation);
      z.xz *= chRot(0.40269908169 * uAlienFoldRotation);
      z.yz *= chRot(0.17179938779 * uAlienFoldRotation);
      z = z * scale - offset * (scale - 1.1);
      scaleTracker *= scale;
      trap = min(trap, abs(z));
    }
    float fractal = (length(z) - 1.22) / scaleTracker;
    return vec4(fractal, trap);
  }

  vec3 chRotateCrystal(vec3 p) {
    p.yz *= chRot(uCrystalRotation.x);
    p.xz *= chRot(uCrystalRotation.y);
    p.xy *= chRot(uCrystalRotation.z);
    return p;
  }

  float chSdSphere(vec3 p, float radius) {
    return length(p) - radius;
  }

  float chSdEllipsoid(vec3 p, vec3 radius) {
    vec3 safeRadius = max(radius, vec3(0.0001));
    float k0 = length(p / safeRadius);
    float k1 = length(p / (safeRadius * safeRadius));
    return k0 * (k0 - 1.0) / max(k1, 0.0001);
  }

  float chSdRoundCone(vec3 p, float baseRadius, float tipRadius, float height) {
    float safeHeight = max(height, 0.001);
    float b = (baseRadius - tipRadius) / safeHeight;
    float a = sqrt(max(1.0 - b * b, 0.0));
    vec2 q = vec2(length(p.xz), p.y);
    float k = dot(q, vec2(-b, a));
    float dBase = length(q) - baseRadius;
    float dTip = length(q - vec2(0.0, safeHeight)) - tipRadius;
    float dSide = dot(q, vec2(a, b)) - baseRadius;
    return mix(mix(dSide, dTip, step(a * safeHeight, k)), dBase, step(k, 0.0));
  }

  vec2 chCreatureUnion(vec2 a, vec2 b) {
    return b.x < a.x ? b : a;
  }

  vec2 chCreatureSmoothUnion(vec2 a, vec2 b, float smoothing) {
    float k = max(smoothing, 0.0001);
    float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
    float distance = mix(b.x, a.x, h) - k * h * (1.0 - h);
    float materialId = mix(b.y, a.y, step(0.5, h));
    return vec2(distance, materialId);
  }

  vec2 chCreatureSubtract(vec2 shape, float cut, float smoothing, float cutId) {
    float cutSurface = -cut;
    float distance = chSmoothMax(shape.x, cutSurface, smoothing);
    float materialId = mix(shape.y, cutId, step(shape.x, cutSurface));
    return vec2(distance, materialId);
  }

  // GLSL port of demos/sdf-creature.html's TSL anatomy, excluding its cursor blob and collision dent.
  // Both Chrysalis phases evaluate this exact field: the living phase warps it, while crystal growth
  // progressively restores these rigid coordinates and applies Xenolith's facet lattice.
  vec2 chCreatureSDF(vec3 pInput) {
    const float ID_SKIN = 0.0;
    const float ID_HORN = 2.0;
    const float ID_EYE = 3.0;
    const float ID_MOUTH = 4.0;
    const float ID_TOOTH = 5.0;

    float scale = max(uBodyRadius, 0.05);
    vec3 p = pInput / scale + vec3(0.0, 0.88, 0.0);
    float width = uAnatomyBodyWidth;

    vec3 legP = vec3(abs(p.x) - 0.255 * width, p.y, p.z - 0.02);
    vec2 result = vec2(
      chSdRoundCone(legP, 0.15, 0.118, 0.42 * uAnatomyLegScale),
      ID_SKIN
    );

    float upper = chSdEllipsoid(
      p - vec3(0.0, 1.02, 0.0),
      vec3(0.60 * width, 0.66, 0.56 * width)
    );
    float lower = chSdEllipsoid(
      p - vec3(0.0, 0.56, 0.0),
      vec3(0.50 * width, 0.40, 0.48 * width)
    );
    vec2 body = chCreatureSmoothUnion(vec2(upper, ID_SKIN), vec2(lower, ID_SKIN), 0.32);
    result = chCreatureSmoothUnion(result, body, 0.15);

    vec3 hornP = vec3(abs(p.x) - 0.30 * width, p.y - 1.40, p.z + 0.02);
    hornP.xy *= chRot(-0.30);
    hornP.yz *= chRot(0.26);
    float horn = chSdRoundCone(hornP, 0.10, 0.012, 0.34 * uAnatomyAppendageLength);
    result = chCreatureSmoothUnion(result, vec2(horn, ID_HORN), 0.05);

    float eye = chSdSphere(
      p - vec3(0.10, 1.16, 0.32 * width),
      0.30 * uAnatomyEyeSize
    );
    result = chCreatureUnion(result, vec2(eye, ID_EYE));

    float mouth = chSdEllipsoid(
      p - vec3(0.14, 0.70, 0.50 * width),
      vec3(0.155, 0.10, 0.15)
    );
    result = chCreatureSubtract(result, mouth, 0.035, ID_MOUTH);

    float tooth = chSdEllipsoid(
      p - vec3(0.075, 0.762, 0.50 * width),
      vec3(0.030, 0.044, 0.032)
    );
    result = chCreatureUnion(result, vec2(tooth, ID_TOOTH));

    result.x *= scale;
    return result;
  }

  float chSdSegmentTaper(vec3 p, vec3 a, vec3 b, float radiusA, float radiusB) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
    return (length(pa - ba * h) - mix(radiusA, radiusB, h)) * 0.97;
  }

  float chBugSmoothstep(float edgeA, float edgeB, float x) {
    float t = clamp((x - edgeA) / (edgeB - edgeA), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }

  float chBugFootY(float x, float z, float tipRadius) {
    const float SPROUT_RADIUS = 2.4;
    float leafY = sqrt(max(SPROUT_RADIUS * SPROUT_RADIUS - x * x - z * z, 0.0));
    return leafY - SPROUT_RADIUS + tipRadius * 0.65;
  }

  float chBugLeg(
    vec3 p,
    vec3 hip,
    vec3 knee,
    vec2 footXZ,
    vec3 radii,
    float spread
  ) {
    knee.x *= spread;
    vec3 foot = vec3(
      footXZ.x * spread,
      chBugFootY(footXZ.x * spread, footXZ.y, radii.z),
      footXZ.y
    );
    return min(
      chSdSegmentTaper(p, hip, knee, radii.x, radii.y),
      chSdSegmentTaper(p, knee, foot, radii.y, radii.z)
    );
  }

  // GLSL port of demos/bug-sdf.js's tested beetle field. The leaf is deliberately excluded: the bug,
  // not its original photographic setting, is the anatomy that enters the Chrysalis synthesis.
  vec2 chBugSDF(vec3 pInput) {
    const float ID_SHELL = 0.0;
    const float ID_HEAD = 1.0;
    const float ID_EYE = 2.0;
    const float ID_LEG = 3.0;
    const float ID_ANTENNA = 4.0;

    float scale = max(uBodyRadius, 0.05);
    vec3 p = pInput / scale + vec3(0.0, 0.29, 0.10);
    float width = uAnatomyBodyWidth;
    float spread = uAnatomyLegScale;
    vec3 mirroredP = vec3(abs(p.x), p.y, p.z);

    float abdomen = chSdEllipsoid(
      p - vec3(0.0, 0.33, -0.10),
      vec3(0.285 * width, 0.255, 0.36) * uBugAbdomenScale
    );
    float pronotum = chSdEllipsoid(
      p - vec3(0.0, 0.31, 0.22),
      vec3(0.235 * width, 0.205, 0.16)
    );
    vec2 result = chCreatureSmoothUnion(
      vec2(abdomen, ID_SHELL),
      vec2(pronotum, ID_SHELL),
      0.09
    );

    float head = chSdEllipsoid(
      p - vec3(0.0, 0.262, 0.40),
      vec3(0.175 * width, 0.155, 0.14) * uBugHeadScale
    );
    result = chCreatureSmoothUnion(result, vec2(head, ID_HEAD), 0.055);

    float grooveX = exp(-pow(p.x / 0.07, 2.0));
    float grooveY = chBugSmoothstep(0.26, 0.52, p.y);
    float grooveZ = chBugSmoothstep(0.30, 0.14, p.z)
      * chBugSmoothstep(-0.50, -0.26, p.z);
    result.x += uBugGrooveDepth * grooveX * grooveY * grooveZ;

    float legDistance = chBugLeg(
      mirroredP,
      vec3(0.150, 0.170, 0.290), vec3(0.290, 0.255, 0.415),
      vec2(0.345, 0.500), vec3(0.033, 0.024, 0.010), spread * uBugLegSpread.x
    );
    legDistance = min(legDistance, chBugLeg(
      mirroredP,
      vec3(0.175, 0.160, 0.045), vec3(0.345, 0.245, 0.080),
      vec2(0.420, 0.120), vec3(0.033, 0.024, 0.010), spread * uBugLegSpread.y
    ));
    legDistance = min(legDistance, chBugLeg(
      mirroredP,
      vec3(0.165, 0.160, -0.180), vec3(0.320, 0.235, -0.320),
      vec2(0.385, -0.435), vec3(0.031, 0.023, 0.010), spread * uBugLegSpread.z
    ));
    result = chCreatureSmoothUnion(result, vec2(legDistance, ID_LEG), 0.022);

    vec3 eyeAt = vec3(0.135, 0.288, 0.452);
    float eyeRadius = 0.086 * uAnatomyEyeSize;
    vec2 bearing = normalize(vec2(0.343, 0.657));
    float elevation = uBugAntennaElevation;
    float ring = max(sqrt(max(1.0 - elevation * elevation, 0.0)), 0.55);
    vec3 rootDirection = normalize(vec3(bearing.x * ring, elevation, bearing.y * ring));
    vec3 antennaRoot = vec3(0.0, 0.262, 0.40)
      + rootDirection * vec3(0.175 * width, 0.155, 0.14) * 0.90;
    vec3 eyeToRoot = antennaRoot - eyeAt;
    float eyeToRootLength = max(length(eyeToRoot), 1e-5);
    antennaRoot = eyeAt + eyeToRoot / eyeToRootLength
      * max(eyeToRootLength, eyeRadius + 0.014);
    vec2 antennaBearing = normalize(vec2(0.107, 0.170));
    float antennaLength = length(vec3(0.107, -0.040, 0.170)) * uAnatomyAppendageLength;
    vec3 antennaDirection = vec3(
      antennaBearing.x * cos(uBugAntennaPitch),
      sin(uBugAntennaPitch),
      antennaBearing.y * cos(uBugAntennaPitch)
    );
    vec3 antennaTip = antennaRoot + antennaDirection * antennaLength;
    float antenna = min(
      chSdSegmentTaper(
        mirroredP, antennaRoot, antennaTip,
        0.020 * uBugAntennaThickness, 0.028 * uBugAntennaThickness
      ),
      chSdSphere(mirroredP - antennaTip, 0.030 * uBugAntennaThickness)
    );
    result = chCreatureSmoothUnion(result, vec2(antenna, ID_ANTENNA), 0.018);

    float eye = chSdSphere(mirroredP - eyeAt, eyeRadius);
    result = chCreatureUnion(result, vec2(eye, ID_EYE));
    result.x *= scale;
    return result;
  }

  vec2 chAnatomySDF(vec3 p) {
    return uAnatomyMode == 1 ? chCreatureSDF(p) : chBugSDF(p);
  }

  // Xenolith's skewed triangular lattice. Unlike smooth noise, max() preserves hard intersections.
  float chCrystalDisturbance(vec3 position) {
    const float goldenRatio = 2.788033988;
    const mat3 basis = mat3(
      -0.131464913, -0.048044873, 0.062087367,
      -0.465078618, -0.016973341, 0.454042493,
       0.086597072,  1.681518454, 0.009753815
    );
    vec3 shaped = position * vec3(
      uLatticeAnisotropy,
      1.0,
      1.0 / max(uLatticeAnisotropy, 0.05)
    );
    shaped.x += shaped.y * uLatticeSkew;
    shaped.z += shaped.x * uLatticeSkew * 0.35;
    vec3 p = shaped * basis;
    vec3 tri1 = abs(fract(p) * 2.0 - 1.0);
    vec3 tri2 = abs(fract(p * goldenRatio) * 2.1 - 1.0);
    return (max(max(tri1.x, tri1.y), tri1.z) + dot(tri1, tri2) * 0.5) * 0.6;
  }

  float chTrapVeins(vec3 trap) {
    return clamp(
      exp(-12.0 * uAlienVeinWidth * trap.x) * 0.53 +
      exp(-10.0 * uAlienVeinWidth * trap.y) * 0.50 +
      exp(-8.0 * uAlienVeinWidth * trap.z) * 0.35,
      0.0, 1.0
    );
  }

  // Directional seeds are analytic state: their radii advance in JavaScript, while this function makes
  // the front follow Alien Cell's tissue channels. Negative-polarity seeds heal instead of crystallize.
  float chGrowthField(vec3 direction, vec3 trap) {
    float positive = clamp(uGlobalGrowth, 0.0, 1.0);
    float negative = 0.0;
    float veinShift = (chTrapVeins(trap) - 0.35) * uVeinAffinity * 0.16;
    for (int i = 0; i < CHRYSALIS_MAX_SEEDS; i++) {
      if (i >= uSeedCount) break;
      vec3 seedDirection = normalize(uSeedDirRadius[i].xyz);
      float radius = uSeedDirRadius[i].w;
      float strength = uSeedMeta[i].x;
      float polarity = uSeedMeta[i].y;
      float angle = acos(clamp(dot(direction, seedDirection), -1.0, 1.0));
      float wave = (1.0 - smoothstep(
        radius - uGrowthFeather,
        radius + uGrowthFeather,
        angle - veinShift
      )) * strength;
      if (polarity >= 0.0) positive = max(positive, wave);
      else negative = max(negative, wave);
    }
    return clamp(positive - negative, 0.0, 1.0);
  }

  struct ChrysalisSample {
    float d;
    float growth;
    float front;
    float stress;
    float organicDistance;
    float crystalDistance;
    float disturbance;
    float anatomy;
    vec3 trap;
  };

  ChrysalisSample chEvaluate(vec3 p) {
    float radius = max(length(p), 0.0001);
    vec3 direction = p / radius;
    vec3 warpedDirection = chWarpDirection(direction);
    float membraneNoise = chValueNoise(
      warpedDirection * uOrganicNoiseScale + uTime * uOrganicNoiseVelocity
    );
    float radialRelief = (smoothstep(0.18, 0.82, membraneNoise) - 0.5) * uOrganicRelief;
    radialRelief += sin(
      uTime * uOrganicPulseFrequency - radius * uOrganicPulseWavelength
    ) * uOrganicPulse;
    vec3 pBio = p - direction * radialRelief;

    vec2 anatomyOrganic = chAnatomySDF(pBio);
    vec4 alien = chAlienTissue(pBio);
    float tissueVeins = chTrapVeins(alien.yzw);
    float tissueFold = clamp(alien.x, -0.12, 0.12);
    float dOrganic = anatomyOrganic.x;
    dOrganic += tissueFold * uCellStructure * uFoldDisplacement;
    dOrganic -= (tissueVeins - 0.35) * uCellStructure * uVeinEmboss;

    float growth = chGrowthField(direction, alien.yzw);
    float stiffness = pow(growth, max(uCrystalStiffness, 0.05));
    vec3 pPhase = mix(pBio, p, stiffness);
    vec2 anatomyCrystal = chAnatomySDF(pPhase);
    vec3 crystalP = chRotateCrystal(pPhase);
    float disturbance = chCrystalDisturbance(crystalP * uFacetFrequency * uCrystalScale);
    float dCrystal = anatomyCrystal.x;
    dCrystal -= (disturbance - 0.48) * uFacetRelief;

    float front = 4.0 * growth * (1.0 - growth);
    float stress = length(pBio - p) * front;
    float d = mix(dOrganic, dCrystal, growth);
    d -= front * uFrontRelief * (disturbance - 0.35);
    d = max(d, uCoreRadius - radius);

    ChrysalisSample state;
    state.d = d;
    state.growth = growth;
    state.front = front;
    state.stress = stress;
    state.organicDistance = dOrganic;
    state.crystalDistance = dCrystal;
    state.disturbance = disturbance;
    state.anatomy = mix(anatomyOrganic.y, anatomyCrystal.y, step(0.5, growth));
    state.trap = alien.yzw;
    return state;
  }

  float chDistance(vec3 p) {
    return chEvaluate(p).d;
  }

  float chOrganicInterior(vec3 p, ChrysalisSample state) {
    vec3 q = p;
    q.xz *= chRot(uTime * 0.10 + 0.20 * sin(q.y * 2.7));
    q.xy *= chRot(-uTime * 0.07 + state.growth * 0.18);
    float a = atan(q.z, q.x);
    float r = length(q);
    float flowA = smoothstep(0.34, 0.92, 0.5 + 0.5 * sin(a * 7.0 + q.y * 5.5 - uTime * 0.85));
    float flowB = smoothstep(0.28, 0.88, 0.5 + 0.5 * sin(r * 9.0 - q.y * 4.0 + uTime * 0.58));
    return clamp(chTrapVeins(state.trap) * 0.65 + flowA * 0.22 + flowB * 0.13, 0.0, 1.0);
  }

  float chCrystalInterior(vec3 p, ChrysalisSample state) {
    vec3 q = chRotateCrystal(p);
    q.xy *= chRot(q.z * 0.18);
    float low = chCrystalDisturbance(q * 7.3) * 0.10;
    float high = chCrystalDisturbance(q * 3.3);
    float structure = abs(low - high);
    return clamp((0.32 - structure) * 4.0 + state.disturbance * 0.18, 0.0, 1.0);
  }

  float chInteriorDensity(vec3 p, ChrysalisSample state) {
    float organic = chOrganicInterior(p, state);
    float crystal = chCrystalInterior(p, state);
    float fracture = state.front * (0.25 + state.stress * 7.0);
    return mix(organic, crystal, state.growth) + fracture;
  }
`;
