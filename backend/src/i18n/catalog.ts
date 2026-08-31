/**
 * Shared message-key catalog.
 *
 * This module is the single source of truth for every translatable string the
 * server emits. It must stay dependency-free: NO imports, no `node:` builtins,
 * no DOM types — so both the backend tsconfig (`rootDir: "."`) and the stricter
 * frontend tsconfig (`noUnusedLocals`/`noUnusedParameters`) can compile it, and
 * the frontend can import upward through the path alias in its own tsconfig.
 *
 * Three independent legs make the boundary safe:
 *   1. `msg<K>()` is generic over `MessageParams`, so a wrong key or wrong
 *      param shape is a build error (backend gate).
 *   2. The frontend `t()` is typed from its EN bundle, so it only names keys
 *      that exist (frontend gate).
 *   3. `backend/tests/i18nCatalog.test.ts` reads `MESSAGE_SPECS` and the three
 *      `server.*.json` files and asserts every locale interpolates exactly the
 *      declared params, expands the correct suffix set, and never embeds a
 *      `$` or a hardcoded separator (runtime gate).
 */

/** A single non-empty param value carried in a message ref. */
type ParamValue = string | number;

interface BaseMessageSpec {
  /** Named `{{param}}` placeholders the locale string must interpolate. */
  params?: readonly string[];
  /** i18next plural key: the locale expands `_one`/`_other` suffixes. */
  count?: boolean;
  /** i18next ORDINAL plural key ("3rd", "3e", "3º"): the locale expands the
   *  full `_ordinal_one`/`_ordinal_two`/`_ordinal_few`/`_ordinal_other` set
   *  (English needs all four; other locales may only ever select "other",
   *  but still declare all four so every locale has the same key shape). Uses
   *  the `count` param, same as cardinal plurals — never combine with `count`. */
  ordinal?: boolean;
  /** i18next `context` variants; the locale expands `_<ctx>` suffixes. */
  context?: readonly string[];
  /** Params that are RAW integer money values; the client formats them. */
  money?: readonly string[];
  /** Frame key: the locale provides `key.lead` and `key.tail` instead of a
   *  direct value, and the client composes lead + entry list + tail. */
  frame?: boolean;
  /** Composite body ref: no direct value; its params are validated against the
   *  union of its `key.*` children (e.g. `news.preseason`). */
  composite?: boolean;
}

export type MessageSpec = BaseMessageSpec;

/** Full catalog. `satisfies` keeps each entry a valid spec shape. */
export const MESSAGE_SPECS = {
  // --- Frames (grouped news bodies: lead + entry list + tail) -------------
  "news.contract.warning": { frame: true },
  "news.contract.expiry": { frame: true },
  "news.contract.renewal": { frame: true },
  "news.academy": { frame: true },
  "news.injuries": { frame: true },
  "news.loans": { frame: true },
  "news.transfers": { frame: true },
  "news.finance": { frame: true },
  "news.tribunal": { frame: true },
  "news.retirement": { frame: true },
  "news.clubStatus": { frame: true },
  "news.tacticsOrders": { frame: true },
  "news.tacticsLineup": { frame: true },

  // --- Headlines (static keys; client renders t(headline)) ----------------
  "news.headline.academy": {},
  "news.headline.contractWarning": {},
  "news.headline.contractExpiry": {},
  "news.headline.contractRenewal": {},
  "news.headline.injuries": {},
  "news.headline.loans": {},
  "news.headline.retirement": {},
  "news.headline.freeAgent": {},
  "news.headline.transfer": {},
  "news.headline.finance": {},
  "news.headline.tribunal": {},
  "news.headline.pyramid": {},
  "news.headline.inactivity": {},
  "news.headline.tactics": {},
  "news.headline.squadUpdate": {},
  "news.headline.outlook": {},

  // --- Entry detail/label prose -------------------------------------------
  "news.detail.promotedAge": { params: ["age"] },
  "news.detail.promotedTerms": {},
  "news.detail.dismissed": {},
  "news.detail.contractWarning": { params: ["count"], count: true },
  "news.detail.contractExpiry": { params: ["club"] },
  "news.detail.renewed": { params: ["count"], count: true },
  "news.detail.loanReturn": { params: ["club", "loan"] },
  "news.detail.loanRemoved": { params: ["club"] },
  "news.detail.retirement": { params: ["club"] },
  "news.detail.injury": { params: ["count"], count: true },
  "news.detail.freeAgentSigned": { params: ["winner", "player", "price"], money: ["price"] },
  "news.detail.auctionWon": { params: ["winner", "price"], money: ["price"] },
  "news.detail.auctionWonTax": { params: ["winner", "price", "tax"], money: ["price", "tax"] },
  "news.detail.liquidation": { params: ["club", "price"], money: ["price"] },
  "news.detail.outlook": {},
  "news.detail.tribunal": { params: ["club"], count: true, context: ["violent", "serious", "foul"] },
  "news.detail.tactics": {},
  "news.detail.tacticsLineup": {},
  "news.detail.join": { params: ["division"] },
  "news.detail.return": { params: ["division"] },
  "news.detail.inactive": {},
  "news.detail.dormant": {},
  "news.detail.aiTakeover": {},

  // --- Ungrouped text bodies (rendered directly from a ref) ---------------
  "news.releasePaid": { params: ["player", "club", "cost"], money: ["cost"] },
  "news.releaseFree": { params: ["player", "club"] },
  "news.auctionCancelled": { params: ["player", "reason"] },
  "news.auctionCancelledUnsettled": { params: ["player"] },
  "news.welcome.body": {},
  "news.welcome.headline": {},

  // --- Pre-season report (composed client-side with a special branch) -----
  "news.preseason": { params: ["division", "cash", "count", "finance"], money: ["cash"], count: true, composite: true },
  "news.preseason.leadWithDivision": { params: ["division"] },
  "news.preseason.leadNoDivision": {},
  "news.preseason.headline": {},
  "news.preseason.finance_safe": { params: ["cash"], money: ["cash"] },
  "news.preseason.finance_atRisk": { params: ["cash"], money: ["cash"] },
  "news.preseason.finance_negative": { params: ["cash"], money: ["cash"] },
  "news.preseason.contractNone": {},
  "news.preseason.contract": { params: ["count"], count: true },
  "news.preseason.dressingRoom": {},
  "news.preseason.boardroom": {},
  "news.preseason.division": { params: ["division"] },
  "news.preseason.lastSeason": {},
  "news.preseason.finished": { params: ["division"], ordinal: true },
  "news.preseason.movement": {},
  "news.preseason.movement_promoted": {},
  "news.preseason.movement_relegated": {},
  "news.preseason.movement_regrouped": {},
  "news.preseason.cash": {},
  "news.preseason.amount": { params: ["amount"], money: ["amount"] },
  "news.preseason.cushion": {},
  "news.preseason.cushion_safe": { params: ["amount"], money: ["amount"] },
  "news.preseason.cushion_atRisk": { params: ["amount"], money: ["amount"] },
  "news.preseason.cushion_negative": { params: ["amount"], money: ["amount"] },
  "news.preseason.contractsMore": { params: ["count"] },
  "news.preseason.additionalApproaching": {},
  "news.preseason.squad": {},
  "news.preseason.professionals": { params: ["count"], count: true },
  "news.preseason.academy": {},
  "news.preseason.youthPlayers": { params: ["count"], count: true },
  "news.preseason.promotions": {},
  "news.preseason.promotedCount": { params: ["count"], count: true },
  "news.preseason.intake": {},
  "news.preseason.intakeCount": { params: ["count"], count: true },
  "news.preseason.replacements": {},
  "news.preseason.replacementsCount": { params: ["count"], count: true },
  "news.preseason.firstFixture": {},
  "news.preseason.fixture": { params: ["opponent", "day"], context: ["home", "away"] },
} as const satisfies Record<string, MessageSpec>;

export type MessageKey = keyof typeof MESSAGE_SPECS;

type SpecForKey<K extends MessageKey> = (typeof MESSAGE_SPECS)[K];

type RequiredParams<S> = S extends { params: readonly (infer P)[] }
  ? P extends string
    ? { [K in P]: ParamValue }
    : {}
  : {};
type CountParams<S> = S extends { count: true } ? { count: number } : {};
type OrdinalParams<S> = S extends { ordinal: true } ? { count: number } : {};
type ContextParams<S> = S extends { context: readonly (infer C)[] }
  ? C extends string
    ? { context: C }
    : {}
  : {};

/** Param object a `msg()` call must pass for a given key. */
export type MessageParams<K extends MessageKey> = RequiredParams<SpecForKey<K>> &
  CountParams<SpecForKey<K>> &
  OrdinalParams<SpecForKey<K>> &
  ContextParams<SpecForKey<K>>;

/** A translatable reference. The `k` is a stable catalog key; `p` carries raw
 *  values (money as integers) that the client formats at render time. */
export interface MessageRef<K extends MessageKey = MessageKey> {
  readonly k: K;
  readonly p?: MessageParams<K>;
}

/** Any user-facing slot: a bare string is a proper name (identical in every
 *  locale) or a legacy English value; a `MessageRef` is translatable copy. */
export type Displayable = string | MessageRef;

/**
 * Build a message ref. `K` is inferred from `k`, so passing the wrong key or
 * the wrong param shape is a compile error.
 */
export function msg<K extends MessageKey>(k: K, p?: MessageParams<K>): MessageRef<K> {
  return p === undefined ? { k } : { k, p };
}

/** Narrow a `Displayable` to a `MessageRef`. */
export function isMessageRef(value: Displayable | null | undefined): value is MessageRef {
  return typeof value === "object" && value !== null && "k" in value;
}