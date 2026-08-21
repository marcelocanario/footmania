import { z } from "zod";
import { LOGO_CONFIG } from "../config";

export const logoVariantSchema = z.number().int().min(0).max(Math.max(0, LOGO_CONFIG.variantCount - 1));

export function validateLogoVariant(v: unknown): string | null {
  const r = logoVariantSchema.safeParse(v);
  return r.success ? null : "Invalid logo variant";
}

const base64Pattern = /^[A-Za-z0-9+/=]+$/;

export function validateCustomLogo(input: { mime: string; data: string }): string | null {
  if (!LOGO_CONFIG.allowedMimes.includes(input.mime as never)) return `Unsupported image type: ${input.mime}`;
  const stripped = input.data.replace(/\s/g, "");
  if (!base64Pattern.test(stripped)) return "Invalid base64 data";
  let bytes: number;
  try {
    bytes = Buffer.from(stripped, "base64").length;
  } catch {
    return "Invalid base64 data";
  }
  if (bytes > LOGO_CONFIG.maxBytes) return `Image too large (max ${LOGO_CONFIG.maxBytes} bytes)`;
  // Basic magic-byte check to ensure the declared mime matches the content
  const buf = Buffer.from(stripped, "base64");
  if (input.mime === "image/png" && !(buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return "PNG data does not look like a PNG";
  if (input.mime === "image/jpeg" && !(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8)) return "JPEG data does not look like a JPEG";
  if (input.mime === "image/webp" && !(buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")) return "WebP data does not look like a WebP";
  // Dimension check would require an image decoder (e.g., sharp/image-size); byte limit is the primary guard.
  // LOGO_CONFIG.maxDimension is applied client-side; server trusts the byte limit for now.
  return null;
}

export function isValidBase64Image(data: string): boolean {
  try {
    // Check decodability quickly
    Buffer.from(data, "base64");
    return base64Pattern.test(data.replace(/\s/g, ""));
  } catch {
    return false;
  }
}
