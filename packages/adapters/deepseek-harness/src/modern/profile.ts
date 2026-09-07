export type DeepSeekModernVersion = "0.1.2-rc.1" | "0.1.3-rc.1";

export interface DeepSeekModernProfile {
  readonly version: DeepSeekModernVersion;
  readonly sessionFormatVersion: 0 | 2;
  readonly assistantStream: boolean;
}

export const DEEPSEEK_V012_PROFILE: DeepSeekModernProfile = Object.freeze({
  version: "0.1.2-rc.1",
  sessionFormatVersion: 0,
  assistantStream: false,
});

export const DEEPSEEK_V013_PROFILE: DeepSeekModernProfile = Object.freeze({
  version: "0.1.3-rc.1",
  sessionFormatVersion: 2,
  assistantStream: true,
});

export function deepSeekModernProfile(version: DeepSeekModernVersion): DeepSeekModernProfile {
  return version === "0.1.2-rc.1" ? DEEPSEEK_V012_PROFILE : DEEPSEEK_V013_PROFILE;
}

export function isDeepSeekV013(profile: DeepSeekModernProfile): boolean {
  return profile.version === "0.1.3-rc.1";
}
