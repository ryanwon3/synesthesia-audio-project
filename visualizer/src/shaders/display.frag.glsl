precision highp float;

varying vec2 vUv;
uniform sampler2D uPainting;
uniform float uTime;
uniform vec2 uResolution;

float grain(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 0.1) * 43758.5453);
}

void main() {
  vec3 color = texture2D(uPainting, vUv).rgb;
  float vignette = smoothstep(1.18, 0.22, length((vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0)));
  color *= 0.78 + vignette * 0.34;
  color += (grain(gl_FragCoord.xy) - 0.5) * 0.009;
  color = pow(max(color, 0.0), vec3(0.6));
  gl_FragColor = vec4(color, 1.0);
}
