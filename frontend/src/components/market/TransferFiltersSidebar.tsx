import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { InputText } from "primereact/inputtext";
import { MultiSelect } from "primereact/multiselect";
import { Filter, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import type { SkillSet } from "../../api/client";
import { DISPLAY_ORDER } from "../../positions";

export interface SortOption {
  value: string;
  label: string;
}

export interface MarketFilters {
  query: string;
  positions: string[];
  sortKey: string;
  overallMin: number | null;
  overallMax: number | null;
  ageMin: number | null;
  ageMax: number | null;
  valueMin: number | null;
  valueMax: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  skillMins: Partial<Record<keyof SkillSet, number>>;
}

export function createMarketFilters(): MarketFilters {
  return {
    query: "",
    positions: [],
    sortKey: "ovr-desc",
    overallMin: null,
    overallMax: null,
    ageMin: null,
    ageMax: null,
    valueMin: null,
    valueMax: null,
    salaryMin: null,
    salaryMax: null,
    priceMin: null,
    priceMax: null,
    skillMins: {},
  };
}

const POSITION_OPTIONS = DISPLAY_ORDER.map((label) => ({ label, value: label }));
function skillOptions(): [keyof SkillSet, string][] {
  const t = i18n.t as unknown as (k: string) => string;
  return [
    ["gol", t("market.skills.gol")],
    ["pace", t("market.skills.pace")],
    ["tec", t("market.skills.tec")],
    ["pas", t("market.skills.pas")],
    ["des", t("market.skills.des")],
    ["playmaking", t("market.skills.playmaking")],
    ["fin", t("market.skills.fin")],
  ];
}

function RangeField({
  label,
  min,
  max,
  onMin,
  onMax,
  minValue = 0,
  maxValue,
  unit,
}: {
  label: string;
  min: number | null;
  max: number | null;
  onMin: (value: number | null) => void;
  onMax: (value: number | null) => void;
  minValue?: number;
  maxValue?: number;
  unit?: "thousands";
}) {
  const { t } = useTranslation();
  const scale = unit === "thousands" ? 1_000 : 1;
  const displayValue = (value: number | null) => value === null ? null : Math.round(value / scale);
  const storedValue = (value: number | null) => value === null ? null : value * scale;
  return (
    <div className="transfer-filter-range">
      <span>{label}</span>
      <div>
        <InputNumber
          value={displayValue(min)}
          onValueChange={(event) => onMin(storedValue(event.value ?? null))}
          min={minValue === undefined ? undefined : minValue / scale}
          max={maxValue === undefined ? undefined : maxValue / scale}
          prefix={unit === "thousands" ? "$" : undefined}
          suffix={unit === "thousands" ? "k" : undefined}
          minFractionDigits={0}
          maxFractionDigits={0}
          placeholder={t("market.min")}
          aria-label={t("market.minAria", { label })}
        />
        <InputNumber
          value={displayValue(max)}
          onValueChange={(event) => onMax(storedValue(event.value ?? null))}
          min={minValue === undefined ? undefined : minValue / scale}
          max={maxValue === undefined ? undefined : maxValue / scale}
          prefix={unit === "thousands" ? "$" : undefined}
          suffix={unit === "thousands" ? "k" : undefined}
          minFractionDigits={0}
          maxFractionDigits={0}
          placeholder={t("market.max")}
          aria-label={t("market.maxAria", { label })}
        />
      </div>
    </div>
  );
}

export function TransferFiltersSidebar({
  filters,
  onChange,
  sortOptions,
  resultCount,
  totalCount,
  showPriceFilter = true,
  priceLabel,
}: {
  filters: MarketFilters;
  onChange: (next: MarketFilters) => void;
  sortOptions: SortOption[];
  resultCount: number;
  totalCount: number;
  showPriceFilter?: boolean;
  priceLabel?: string;
}) {
  const { t } = useTranslation();
  const priceLabelText = priceLabel ?? t("market.currentPrice");
  const update = <K extends keyof MarketFilters>(key: K, value: MarketFilters[K]) => onChange({ ...filters, [key]: value });
  const activeFilterCount = [
    filters.query,
    filters.positions.length > 0,
    filters.overallMin !== null,
    filters.overallMax !== null,
    filters.ageMin !== null,
    filters.ageMax !== null,
    filters.valueMin !== null,
    filters.valueMax !== null,
    filters.salaryMin !== null,
    filters.salaryMax !== null,
    showPriceFilter && filters.priceMin !== null,
    showPriceFilter && filters.priceMax !== null,
    Object.keys(filters.skillMins).length > 0,
  ].filter(Boolean).length;

  return (
    <aside className="card transfer-filters-card">
      <div className="transfer-filters-heading">
        <div>
          <h2 className="card-title"><Filter size={17} /> {t("market.findPlayers")}</h2>
          <div className="transfer-filter-meta">{t("market.shownOf", { result: resultCount, total: totalCount })}</div>
        </div>
        {activeFilterCount > 0 && (
          <button className="btn ghost sm" type="button" onClick={() => onChange(createMarketFilters())} title={t("market.clearAll")}>
            <RotateCcw size={13} /> {t("market.clear", { count: activeFilterCount })}
          </button>
        )}
      </div>

      <div className="transfer-filter-bar-top">
        <InputText
          value={filters.query}
          onChange={(event) => update("query", event.target.value)}
          placeholder={t("market.searchPlayerName")}
          aria-label={t("market.searchPlayerName")}
          style={{ width: "100%" }}
        />
        <MultiSelect
          value={filters.positions}
          options={POSITION_OPTIONS}
          onChange={(event) => update("positions", event.value as string[])}
          optionLabel="label"
          optionValue="value"
          placeholder={t("market.allPositions")}
          maxSelectedLabels={1}
          selectedItemsLabel={t("market.positionsSelected")}
          scrollHeight="240px"
          aria-label={t("market.filterByPosition")}
          style={{ width: "100%" }}
        />
        <Dropdown
          value={filters.sortKey}
          options={sortOptions}
          onChange={(event) => update("sortKey", event.value as string)}
          optionLabel="label"
          optionValue="value"
          aria-label={t("market.sortPlayers")}
          style={{ width: "100%" }}
        />
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">{t("market.playerProfile")}</div>
        <div className="transfer-attr-filters">
          <RangeField label="OVR" min={filters.overallMin} max={filters.overallMax} onMin={(value) => update("overallMin", value)} onMax={(value) => update("overallMax", value)} minValue={0} maxValue={100} />
          <RangeField label={t("market.age")} min={filters.ageMin} max={filters.ageMax} onMin={(value) => update("ageMin", value)} onMax={(value) => update("ageMax", value)} minValue={0} maxValue={100} />
        </div>
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">{t("market.money")}</div>
        <div className="transfer-attr-filters">
          <RangeField label={t("market.valueK")} min={filters.valueMin} max={filters.valueMax} onMin={(value) => update("valueMin", value)} onMax={(value) => update("valueMax", value)} unit="thousands" />
          <RangeField label={t("market.salaryK")} min={filters.salaryMin} max={filters.salaryMax} onMin={(value) => update("salaryMin", value)} onMax={(value) => update("salaryMax", value)} unit="thousands" />
          {showPriceFilter && <RangeField label={t("market.priceK", { label: priceLabelText })} min={filters.priceMin} max={filters.priceMax} onMin={(value) => update("priceMin", value)} onMax={(value) => update("priceMax", value)} unit="thousands" />}
        </div>
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">{t("market.minimumSkills")}</div>
        <div className="transfer-skill-filters">
          {skillOptions().map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <InputNumber
                value={filters.skillMins[key] ?? null}
                onValueChange={(event) => {
                  const nextSkills = { ...filters.skillMins };
                  if (event.value == null) delete nextSkills[key];
                  else nextSkills[key] = event.value;
                  onChange({ ...filters, skillMins: nextSkills });
                }}
                min={0}
                max={100}
                placeholder={t("market.any")}
                aria-label={t("market.minSkillAria", { label })}
              />
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}
