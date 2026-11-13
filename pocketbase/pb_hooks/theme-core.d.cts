export type ThemeColors = Record<"background" | "surface" | "raised" | "accent" | "text" | "muted", string>;
export type ThemePreference = { preset: "mauve" | "graphite" | "amber" | "midnight" | "onyx" | "coral" | "porcelain" | "sand" | "custom"; colors: ThemeColors };
export const presets: { id: Exclude<ThemePreference["preset"], "custom">; name: string; colors: ThemeColors }[];
export const colorKeys: (keyof ThemeColors)[];
export function luminance(hex: string): number;
export function contrast(first: string, second: string): number;
export function themeError(theme: unknown): string;
export function normalizeTheme(theme: unknown): ThemePreference;
export function onAccent(accent: string): string;
