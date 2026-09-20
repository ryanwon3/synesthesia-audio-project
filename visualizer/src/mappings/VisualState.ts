export type RgbColor = readonly [red: number, green: number, blue: number];
export interface VisualLayer {
  color: RgbColor;
  energy: number;
  attack: number;
  softness: number;
  effects: [number, number, number, number, number];
}
const quietLayer = (): VisualLayer => ({ color: [0.2, 0.3, 0.4], energy: 0, attack: 0, softness: 0.6, effects: [1, 0, 0, 0, 0] });

export interface VisualState {
  layers: [VisualLayer, VisualLayer, VisualLayer];
  primaryColor: RgbColor;
  secondaryColor: RgbColor;
  accentColor: RgbColor;
  brightness: number;
  saturation: number;
  fluidity: number;
  sharpness: number;
  density: number;
  depth: number;
  persistence: number;
  turbulence: number;
  scale: number;
  particleDensity: number;
  impulseStrength: number;
  spacing: number;
  structuralOrder: number;
  stereoBalance: number;
  stereoWidth: number;
}

export const calmVisualState: VisualState = {
  layers: [quietLayer(), quietLayer(), quietLayer()],
  primaryColor: [0.23, 0.56, 0.52],
  secondaryColor: [0.72, 0.28, 0.42],
  accentColor: [0.88, 0.68, 0.3],
  brightness: 0.12,
  saturation: 0.62,
  fluidity: 0.58,
  sharpness: 0.3,
  density: 0.3,
  depth: 0.62,
  persistence: 0.84,
  turbulence: 0.12,
  scale: 0.36,
  particleDensity: 0.08,
  impulseStrength: 0,
  spacing: 0.56,
  structuralOrder: 0.5,
  stereoBalance: 0.5,
  stereoWidth: 0,
};
