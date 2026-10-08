precision highp float;

varying vec2 vUv;

uniform sampler2D uPrevious;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDelta;
uniform vec4 uDynamics;
uniform vec4 uMaterial;
uniform vec4 uSpace;
uniform vec3 uLayerColors[3];
uniform vec3 uLayerDynamics[3];
uniform vec4 uLayerEffects[3];
uniform vec3 uFragments;
uniform vec4 uRipples[8];
uniform float uRippleMotionScale;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 rotation = mat2(0.82, -0.57, 0.57, 0.82);
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * noise(p);
    p = rotation * p * 2.03 + 17.1;
    amplitude *= 0.49;
  }
  return value;
}

void main() {
  float turbulence = uDynamics.y;
  float scale = uDynamics.w;
  float persistence = uMaterial.x;
  float sharpness = uMaterial.y;
  float particles = uMaterial.w;
  float fluidity = uSpace.x;
  float balance = uSpace.z;
  float width = uSpace.w;

  vec2 aspect = vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  vec2 centered = (vUv - 0.5) * aspect;
  float motion = uTime * (0.025 + fluidity * 0.13);

  vec2 flow = vec2(
    noise(centered * 2.2 + vec2(motion, -motion * 0.6)),
    noise(centered.yx * 2.0 + vec2(9.3 - motion * 0.7, motion))
  ) - 0.5;
  flow *= 0.005 + turbulence * 0.018 + width * 0.009;
  flow.x += (balance - 0.5) * 0.0025;

  vec2 previousUv = clamp(vUv - flow * uDelta * 36.0, 0.002, 0.998);
  vec3 previous = texture2D(uPrevious, previousUv).rgb;

  vec2 p = centered * (1.35 + (1.0 - scale) * 1.8);
  p += vec2(motion * 0.7, -motion * 0.42);
  float broad = fbm(p + fbm(p * 0.62 + motion));
  float folded = fbm(p * (1.75 + sharpness * 1.2) - vec2(broad * 2.1, motion));
  float veil = fbm(p * 0.55 + vec2(-motion * 0.5, broad));
  float filament = pow(max(0.0, 1.0 - abs(folded - broad) * (4.0 + sharpness * 6.0)), 5.0);

  vec2 sparkleCell = floor((centered + motion * 0.05) * (32.0 + particles * 84.0));
  vec2 sparklePoint = fract((centered + motion * 0.05) * (32.0 + particles * 84.0));
  float sparkleSeed = hash21(sparkleCell);
  float sparkle = step(0.985 - particles * 0.08, sparkleSeed);
  sparkle *= smoothstep(0.13, 0.0, length(sparklePoint - vec2(sparkleSeed, fract(sparkleSeed * 17.3))));
  sparkle *= 0.18 + particles * 1.6;

  float rings = 0.0;
  for (int ring = 0; ring < 8; ring++) {
    vec4 pulse = uRipples[ring];
    // Age (pulse.z) is wall-clock; only expansion is slowed under reduced motion.
    float radius = pulse.z * 0.28 * uRippleMotionScale;
    float distanceToRing = abs(length(centered - pulse.xy) - radius + (broad - 0.5) * 0.055);
    float thickness = mix(0.012, 0.047, uLayerDynamics[0].z);
    rings += exp(-distanceToRing * distanceToRing / (thickness * thickness)) * exp(-pulse.z * 0.65) * pulse.w;
  }
  vec3 fresh = vec3(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float energy = uLayerDynamics[layer].x;
    float softness = uLayerDynamics[layer].z;
    vec4 weights = uLayerEffects[layer];
    float layerScale = 1.0 + float(layer) * 1.7;
    float ribbon = pow(0.5 + 0.5 * sin((folded * 2.0 + centered.y * layerScale - motion) * 12.0), mix(12.0, 3.0, softness));
    float cloud = smoothstep(0.4 - uMaterial.z * 0.25, 0.85, mix(broad, veil, float(layer) * 0.25));
    float fragments = pow(max(0.0, 1.0 - abs(fract((centered.x + folded) * layerScale * 5.0) - 0.5) * 8.0), 2.0) * filament;
    float surfaceWave = pow(0.5 + 0.5 * cos(length(centered + vec2(broad * 0.1, -0.12)) *
      (18.0 + float(layer) * 8.0) - motion * 5.0), mix(10.0, 3.0, softness));
    float layerRipples = layer == 0 ? rings : surfaceWave * 0.45;
    float mark = layerRipples * weights.x + ribbon * weights.y * 0.38 + cloud * weights.z * 0.45 +
      sparkle * weights.w * (0.35 + float(layer) * 0.4) + fragments * uFragments[layer] * 0.55;
    fresh += uLayerColors[layer] * mark * energy * (0.3 + float(layer) * 0.08);
  }

  // Time-based feedback stays consistent at 60/120/240 Hz. Never tone-map the
  // feedback repeatedly: that crushed the layers into darkness at high refresh rates.
  float decay = exp(-uDelta * mix(5.0, 1.6, persistence));
  vec3 color = previous * decay + fresh * (1.0 - decay) * 2.8;
  color = max(vec3(0.0), color - uDelta * 0.001);
  color = clamp(color, 0.0, 1.0);

  gl_FragColor = vec4(color, 1.0);
}
