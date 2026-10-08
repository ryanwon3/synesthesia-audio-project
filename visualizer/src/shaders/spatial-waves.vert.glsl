varying vec2 vUv;
varying float vDepth;
uniform float uTime;
uniform float uEnergy;
uniform float uScale;
uniform float uDistortion;
void main() {
  vUv = uv;
  vec3 p = position;
  float phase = p.x * (0.6 + uScale * 1.3);
  p.y += (sin(phase + uTime * 0.35) + sin(phase * 0.63 - uTime * 0.22) * 0.4) * (0.025 + uEnergy * 0.24);
  p.y += sin(phase * 3.1 - uTime * 0.45) * uDistortion * uEnergy * 0.09;
  p.z += sin(phase * 0.47 + uTime * 0.18) * uEnergy * 0.4;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  vDepth = -view.z;
  gl_Position = projectionMatrix * view;
}
