import { describe, expect, it } from "vitest";
import { MESSAGE_SPECS, isMessageRef, msg, type MessageKey, type MessageSpec } from "../src/i18n/catalog";
import en from "../src/i18n/locales/server.en.json";
import fr from "../src/i18n/locales/server.fr.json";
import ptBR from "../src/i18n/locales/server.pt-BR.json";

const LOCALES: Record<string, Record<string, string>> = { en, fr, "pt-BR": ptBR };

function specOf(key: MessageKey): MessageSpec {
  return (MESSAGE_SPECS as Record<string, MessageSpec>)[key];
}

const PLURAL_SUFFIXES = ["_one", "_other"];
// English needs all four CLDR ordinal categories to be grammatically correct
// ("1st"/"2nd"/"3rd"/"4th"); French/Portuguese only ever select "other" (or,
// for French, "one" too), but still declare all four so every locale has the
// same key shape — the unreachable slots are harmless placeholders.
const ORDINAL_SUFFIXES = ["_ordinal_one", "_ordinal_two", "_ordinal_few", "_ordinal_other"];

/** Resolve the concrete locale keys a spec expands to (frames expand to
 *  `.lead`/`.tail`; count/ordinal/context keys expand their i18next suffix
 *  set; composite keys expand to every `key.*` child in the bundle). */
function keysToCheck(key: string, spec: MessageSpec, bundle: Record<string, string>): string[] {
  if (spec.composite) return Object.keys(bundle).filter((k) => k.startsWith(`${key}.`));
  if (spec.frame) return [`${key}.lead`, `${key}.tail`];
  const bases = spec.context && spec.context.length > 0
    ? spec.context.map((ctx) => `${key}_${ctx}`)
    : [key];
  if (spec.ordinal) return bases.flatMap((base) => ORDINAL_SUFFIXES.map((suffix) => `${base}${suffix}`));
  if (!spec.count) return bases;
  return bases.flatMap((base) => PLURAL_SUFFIXES.map((suffix) => `${base}${suffix}`));
}

describe("server message catalog", () => {
  it("resolves every catalog key in every locale with correct suffix expansion", () => {
    for (const key of Object.keys(MESSAGE_SPECS) as MessageKey[]) {
      const spec = specOf(key);
      for (const [lang, bundle] of Object.entries(LOCALES)) {
        const resolved = keysToCheck(key, spec, bundle);
        expect(resolved.length, `${lang} has no keys for ${key}`).toBeGreaterThan(0);
        for (const resolvedKey of resolved) {
          expect(bundle, `${lang} missing ${resolvedKey}`).toHaveProperty(resolvedKey);
        }
      }
    }
  });

  it("interpolates exactly the declared params and never a foreign one", () => {
    for (const key of Object.keys(MESSAGE_SPECS) as MessageKey[]) {
      const spec = specOf(key);
      // Composite keys have no direct value; their children carry their own
      // (per-child) params and are validated individually below.
      if (spec.composite) continue;
      const params = new Set([...(spec.params ?? []), ...(spec.count || spec.ordinal ? ["count"] : [])]);
      for (const bundle of Object.values(LOCALES)) {
        for (const resolvedKey of keysToCheck(key, spec, bundle)) {
          const value = bundle[resolvedKey];
          const placeholders = new Set<string>();
          for (const match of value.matchAll(/\{\{(\w+)\}\}/g)) placeholders.add(match[1]);
          // Every placeholder is a declared param (no foreign interpolations).
          for (const placeholder of placeholders) {
            expect(params.has(placeholder), `${resolvedKey} uses undeclared param {{${placeholder}}}`).toBe(true);
          }
        }
      }
    }
  });

  it("declares every param somewhere in the string (no unused params)", () => {
    for (const key of Object.keys(MESSAGE_SPECS) as MessageKey[]) {
      const spec = specOf(key);
      // Composite params include key-suffix selectors (e.g. `finance`) that are
      // not `{{placeholders}}`; the composite's rendered params (division/cash/
      // count) appear in its children, which are validated individually.
      if (spec.composite) continue;
      const declared = [...(spec.params ?? []), ...(spec.count || spec.ordinal ? ["count"] : [])];
      for (const bundle of Object.values(LOCALES)) {
        const allText = keysToCheck(key, spec, bundle).map((k) => bundle[k] ?? "").join("");
        for (const param of declared) {
          expect(allText.includes(`{{${param}}}`), `${key} declares {{${param}}} but no locale uses it`).toBe(true);
        }
      }
    }
  });

  it("never embeds server-shaped currency formatting in a locale string", () => {
    for (const bundle of Object.values(LOCALES)) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(value, `${key} contains a $`).not.toContain("$");
        expect(value, `${key} contains a thousands separator`).not.toMatch(/[0-9],[0-9]{3}/);
      }
    }
  });

  it("frame keys are never leaves and leaves are never frames", () => {
    for (const key of Object.keys(MESSAGE_SPECS) as MessageKey[]) {
      const spec = specOf(key);
      for (const bundle of Object.values(LOCALES)) {
        if (spec.frame) {
          expect(bundle[key], `${key} is a frame but has a leaf value`).toBeUndefined();
        } else {
          expect(`${key}.lead` in bundle, `${key} is a leaf but has a .lead`).toBe(false);
        }
      }
    }
  });

  it("msg() builds refs and isMessageRef() discriminates them", () => {
    const ref = msg("news.detail.injury", { count: 3 });
    expect(ref.k).toBe("news.detail.injury");
    expect(ref.p).toEqual({ count: 3 });
    expect(isMessageRef(ref)).toBe(true);
    expect(isMessageRef("a player name")).toBe(false);
    expect(isMessageRef(undefined)).toBe(false);
    expect(isMessageRef(null)).toBe(false);
  });
});