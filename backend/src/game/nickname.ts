import { z } from "zod";
import { NICKNAME_CONFIG } from "../config";

const blocklistLower = new Set(NICKNAME_CONFIG.blocklist.map((w) => w.toLowerCase()));

export const nicknameSchema = z
  .string()
  .trim()
  .min(NICKNAME_CONFIG.minLength, `Nickname must be at least ${NICKNAME_CONFIG.minLength} character`)
  .max(NICKNAME_CONFIG.maxLength, `Nickname must be at most ${NICKNAME_CONFIG.maxLength} characters`)
  .refine((v) => /^[a-zA-Z0-9 _'\-]+$/.test(v), "Nickname contains invalid characters")
  .refine((v) => !blocklistLower.has(v.toLowerCase()) && !Array.from(blocklistLower).some((b) => v.toLowerCase().includes(b)), "Nickname contains blocked language");

export function validateNickname(raw: unknown): string | null {
  const res = nicknameSchema.safeParse(raw);
  if (!res.success) return res.error.issues[0]?.message ?? "Invalid nickname";
  return null;
}

export function normalizeNickname(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
