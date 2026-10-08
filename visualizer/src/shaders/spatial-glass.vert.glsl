attribute float aAge;
varying vec2 vUv;
varying float vAge;
varying float vDepth;
void main() {
  vUv = uv;
  vAge = aAge;
  vec4 view = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -view.z;
  gl_Position = projectionMatrix * view;
}
