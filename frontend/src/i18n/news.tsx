import { useTranslation } from "react-i18next";
import {
  MESSAGE_SPECS,
  isMessageRef,
  type Displayable,
  type MessageRef,
  type MessageSpec,
} from "@server-i18n/catalog";
import { money } from "../format";

type LooseT = (key: string, options?: object) => string;

function specOf(key: string): MessageSpec | undefined {
  return (MESSAGE_SPECS as Record<string, MessageSpec | undefined>)[key];
}

/**
 * The catalog's flat, dot-containing keys (e.g. "news.detail.tribunal") are
 * literal property names in the "server" namespace bundle — the SAME JSON
 * files backend/tests/i18nCatalog.test.ts validates — not nested paths, so
 * every lookup here disables i18next's default dot-as-path traversal.
 */
function serverT(t: LooseT, key: string, options?: Record<string, unknown>): string {
  return t(key, { ...options, ns: "server", keySeparator: false });
}

/** Render a single `Displayable` (proper name or message ref) to localized text. */
function renderDisplayable(value: Displayable, t: LooseT): string {
  if (!isMessageRef(value)) return value;
  const spec = specOf(value.k);
  const options: Record<string, unknown> = { ...value.p };
  // Money params are raw integers; format them before interpolation.
  for (const param of spec?.money ?? []) {
    const raw = options[param];
    if (typeof raw === "number") options[param] = money(raw);
  }
  // Ordinal keys ("3rd"/"3e"/"3º") select CLDR ordinal categories off `count`.
  if (spec?.ordinal) options.ordinal = true;
  return serverT(t, value.k, options);
}

/** Render a headline that is either a catalog key or legacy English. */
export function newsHeadline(headline: string | undefined, t: LooseT): string {
  if (!headline) return "";
  return headline in MESSAGE_SPECS ? serverT(t, headline) : headline;
}

/** Render an entry fact list, collapsing a single shared detail per the
 *  grouped-news rule (moved client-side from the old server renderer). */
function listFacts(
  entries: ReadonlyArray<{ label?: Displayable; detail?: Displayable }>,
  t: LooseT,
  lang: string,
): string {
  const seen = new Set<string>();
  const facts: { label: string; detail: string }[] = [];
  for (const entry of entries) {
    const label = entry.label ? renderDisplayable(entry.label, t) : "";
    const detail = entry.detail ? renderDisplayable(entry.detail, t) : "";
    const dedupeKey = `${label}\u0000${detail}`;
    if (seen.has(dedupeKey) || !label) continue;
    seen.add(dedupeKey);
    facts.push({ label, detail });
  }
  if (facts.length === 0) return "";
  const uniqueDetails = new Set(facts.map((f) => f.detail));
  const items =
    uniqueDetails.size <= 1
      ? facts.map((f) => f.label)
      : facts.map((f) => (f.detail ? `${f.label} (${f.detail})` : f.label));
  return new Intl.ListFormat(lang, { type: "conjunction" }).format(items);
}

/** Resolve a news item's full body text: frame + entries when a body is
 *  present, the legacy English `text` otherwise. */
export function newsBodyText(
  item: {
    body?: MessageRef;
    text?: string;
    entries?: ReadonlyArray<{ label?: Displayable; detail?: Displayable }>;
  },
  t: LooseT,
  lang: string,
): string {
  if (!item.body) return item.text ?? "";
  const spec = specOf(item.body.k);
  if (!spec || !spec.frame) {
    if (item.body.k === "news.preseason") return preseasonBody(item.entries ?? [], item.body as MessageRef<"news.preseason">, t, lang);
    return renderDisplayable(item.body, t);
  }
  const lead = serverT(t, `${item.body.k}.lead`);
  const tail = serverT(t, `${item.body.k}.tail`);
  const facts = listFacts(item.entries ?? [], t, lang);
  return `${lead} ${facts}. ${tail}`;
}

/** Compose the bespoke pre-season report: league lead + finance + contract
 *  leads, then the boardroom fact list. */
function preseasonBody(
  entries: ReadonlyArray<{ label?: Displayable; detail?: Displayable }>,
  ref: MessageRef<"news.preseason">,
  t: LooseT,
  lang: string,
): string {
  const p = (ref.p ?? {}) as { division?: number; cash?: number; count?: number; finance?: string };
  const cash = money(p.cash ?? 0);
  const lead = (p.division ?? 0) > 0 ? serverT(t, "news.preseason.leadWithDivision", { division: p.division }) : serverT(t, "news.preseason.leadNoDivision");
  const finance = serverT(t, `news.preseason.finance_${p.finance ?? "safe"}`, { cash });
  const contract = (p.count ?? 0) === 0 ? serverT(t, "news.preseason.contractNone") : serverT(t, "news.preseason.contract", { count: p.count });
  const facts = listFacts(entries, t, lang);
  return `${lead} ${finance} ${contract} ${serverT(t, "news.preseason.dressingRoom")} ${serverT(t, "news.preseason.boardroom")} ${facts}.`;
}

/**
 * Hook exposing the news rendering with reactive `t()` so a language switch
 * re-renders the feed. The renderer reaches into the shared server catalog,
 * which is why the module uses a loose `t` for the (catalog-keyed) dynamic
 * lookups rather than the strictly-typed `useTranslation` `t`.
 */
export function useNews(): {
  t: LooseT;
  body: (item: Parameters<typeof newsBodyText>[0]) => string;
  headline: (h?: string) => string;
} {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const looseT = t as unknown as LooseT;
  return {
    t: looseT,
    body: (item) => newsBodyText(item, looseT, lang),
    headline: (h) => newsHeadline(h, looseT),
  };
}