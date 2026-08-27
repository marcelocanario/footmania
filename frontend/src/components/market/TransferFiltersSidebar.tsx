import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { InputText } from "primereact/inputtext";
import { MultiSelect } from "primereact/multiselect";
import { Filter, RotateCcw } from "lucide-react";
import type { SkillSet } from "../../api/client";

export interface SortOption {
  value: string;
  label: string;
}

export interface MarketFilters {
  query: string;
  positions: number[];
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

const POSITION_OPTIONS = ["GK", "FB", "CB", "MF", "FW"].map((label, value) => ({ label, value }));
const SKILL_OPTIONS: [keyof SkillSet, string][] = [
  ["gol", "Goalkeeping"],
  ["vel", "Speed"],
  ["tec", "Technique"],
  ["pas", "Passing"],
  ["des", "Defending"],
  ["arm", "Playmaking"],
  ["fin", "Finishing"],
];

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
          placeholder="Min"
          aria-label={`${label} minimum`}
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
          placeholder="Max"
          aria-label={`${label} maximum`}
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
  priceLabel = "Current price",
}: {
  filters: MarketFilters;
  onChange: (next: MarketFilters) => void;
  sortOptions: SortOption[];
  resultCount: number;
  totalCount: number;
  showPriceFilter?: boolean;
  priceLabel?: string;
}) {
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
          <h2 className="card-title"><Filter size={17} /> Find players</h2>
          <div className="transfer-filter-meta">{resultCount} of {totalCount} players shown</div>
        </div>
        {activeFilterCount > 0 && (
          <button className="btn ghost sm" type="button" onClick={() => onChange(createMarketFilters())} title="Clear all filters">
            <RotateCcw size={13} /> Clear ({activeFilterCount})
          </button>
        )}
      </div>

      <div className="transfer-filter-bar-top">
        <InputText
          value={filters.query}
          onChange={(event) => update("query", event.target.value)}
          placeholder="Search player name"
          aria-label="Search player name"
          style={{ width: "100%" }}
        />
        <MultiSelect
          value={filters.positions}
          options={POSITION_OPTIONS}
          onChange={(event) => update("positions", event.value as number[])}
          optionLabel="label"
          optionValue="value"
          placeholder="All positions"
          maxSelectedLabels={1}
          selectedItemsLabel="{0} positions"
          scrollHeight="240px"
          aria-label="Filter by position"
          style={{ width: "100%" }}
        />
        <Dropdown
          value={filters.sortKey}
          options={sortOptions}
          onChange={(event) => update("sortKey", event.value as string)}
          optionLabel="label"
          optionValue="value"
          aria-label="Sort players"
          style={{ width: "100%" }}
        />
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">Player profile</div>
        <div className="transfer-attr-filters">
          <RangeField label="OVR" min={filters.overallMin} max={filters.overallMax} onMin={(value) => update("overallMin", value)} onMax={(value) => update("overallMax", value)} minValue={0} maxValue={100} />
          <RangeField label="Age" min={filters.ageMin} max={filters.ageMax} onMin={(value) => update("ageMin", value)} onMax={(value) => update("ageMax", value)} minValue={0} maxValue={100} />
        </div>
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">Money</div>
        <div className="transfer-attr-filters">
          <RangeField label="Value ($k)" min={filters.valueMin} max={filters.valueMax} onMin={(value) => update("valueMin", value)} onMax={(value) => update("valueMax", value)} unit="thousands" />
          <RangeField label="Salary / season ($k)" min={filters.salaryMin} max={filters.salaryMax} onMin={(value) => update("salaryMin", value)} onMax={(value) => update("salaryMax", value)} unit="thousands" />
          {showPriceFilter && <RangeField label={`${priceLabel} ($k)`} min={filters.priceMin} max={filters.priceMax} onMin={(value) => update("priceMin", value)} onMax={(value) => update("priceMax", value)} unit="thousands" />}
        </div>
      </div>

      <div className="transfer-filter-section">
        <div className="section-label">Minimum skills</div>
        <div className="transfer-skill-filters">
          {SKILL_OPTIONS.map(([key, label]) => (
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
                placeholder="Any"
                aria-label={`Minimum ${label}`}
              />
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}
