import { expect, it } from "vitest";
import { isAudioFrameMessage, silentAudioFrame } from "./AudioFrame";
it("accepts legacy and per-band frames but rejects malformed band data", () => {
  const message = { protocolVersion: 1, type: "audioFrame", payload: { ...silentAudioFrame } };
  expect(isAudioFrameMessage(message)).toBe(true);
  const band = { chroma: silentAudioFrame.chroma, chromaConfidence: 0.2, attack: 0.5 };
  expect(isAudioFrameMessage({ ...message, payload: { ...message.payload, bass: band } })).toBe(true);
  expect(isAudioFrameMessage({ ...message, payload: { ...message.payload, bass: { ...band, attack: NaN } } })).toBe(false);
  expect(isAudioFrameMessage({ ...message, payload: { ...message.payload, bass: { ...band, chroma: null } } })).toBe(false);
});
