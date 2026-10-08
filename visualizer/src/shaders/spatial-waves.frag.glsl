varying vec2 vUv;
varying float vDepth;
uniform vec3 uColor;
uniform float uEnergy;
uniform float uSoftness;
uniform float uHaze;
void main() {
  float center = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float ribbon = pow(max(center, 0.0), 1.5 + (1.0 - uSoftness) * 3.0);
  float ends = smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x);
  float fog = exp(-vDepth * vDepth * (0.0007 + uHaze * 0.002));
  gl_FragColor = vec4(uColor * (0.78 + center * 0.22) * fog, ribbon * ends * uEnergy * 0.85);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
