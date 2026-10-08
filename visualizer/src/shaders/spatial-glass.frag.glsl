varying vec2 vUv;
varying float vAge;
varying float vDepth;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uShimmer;
uniform float uHaze;
void main() {
  vec2 edgeDistance = min(vUv, 1.0 - vUv);
  float border = 1.0 - smoothstep(0.015, 0.045, min(edgeDistance.x, edgeDistance.y));
  float highlight = smoothstep(0.65, 1.0, vUv.x + vUv.y) * (0.12 + uShimmer * 0.18);
  float fade = smoothstep(0.0, 0.07, vAge) * (1.0 - smoothstep(0.78, 1.0, vAge));
  float fog = exp(-vDepth * vDepth * (0.0007 + uHaze * 0.002));
  vec3 tint = mix(uColor, vec3(0.88, 0.93, 0.96), 0.2 + border * (0.2 + uShimmer * 0.15));
  gl_FragColor = vec4(tint * fog, min(0.92, uOpacity + border * 0.35 + highlight) * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
