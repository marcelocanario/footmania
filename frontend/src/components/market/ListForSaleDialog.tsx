import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Dialog } from "primereact/dialog";
import { InputNumber } from "primereact/inputnumber";
import { api, type PlayerView } from "../../api/client";
import { useGame } from "../../store/game";
import { money } from "../../format";
import { auctionOpeningRange } from "../../market";
import { useLang } from "../../i18n/store";

const SEASON_PAUSED_TITLE = (): string => i18n.t("market.seasonPaused");

interface SellPreview {
  value: number;
  baseValue: number;
  openingPriceRange: { min: number; max: number };
  cooldownError: string | null;
  alreadyListed: boolean;
}

/**
 * Shared "List for Sale" dialog (opening-price picker with server preview).
 * Used by the Transfers "sell" tab and the Squad page action panel. All
 * guards (pause, cooldown, already-listed, price range) are enforced here.
 */
export function ListForSaleDialog({
  player,
  onClose,
  onListed,
  customTooltips = false,
}: {
  player: PlayerView | null;
  onClose: () => void;
  onListed: () => void;
  customTooltips?: boolean;
}) {
  const { t } = useTranslation();
  const status = useGame((s) => s.status);
  const lang = useLang((s) => s.lang);
  const [preview, setPreview] = useState<SellPreview | null>(null);
  const [price, setPrice] = useState(0);

  useEffect(() => {
    if (!player) {
      setPreview(null);
      setPrice(0);
      return;
    }
    let alive = true;
    setPreview(null);
    setPrice(0);
    api
      .auctionPreview(player.id)
      .then((result) => {
        if (!alive) return;
        setPreview(result);
        setPrice(result.openingPriceRange.max);
      })
      .catch(() => {
        if (!alive) return;
        const range = auctionOpeningRange(player.value);
        setPreview({ value: player.value, baseValue: player.value, openingPriceRange: range, cooldownError: null, alreadyListed: false });
        setPrice(range.max);
      });
    return () => {
      alive = false;
    };
  }, [player?.id]);

  const sell = useCallback(async () => {
    if (!player) return;
    try {
      await api.sellPlayer(player.id, price > 0 ? price : undefined);
      onClose();
      onListed();
    } catch (e) {
      // Surface the server error inline so the user keeps the dialog open to fix it.
      setPreview((prev) => prev ? { ...prev, cooldownError: (e as Error).message } : prev);
    }
  }, [player, price, onClose, onListed]);

  return (
    <Dialog
      header={`${t("transfers.sell")} — ${player?.name ?? ""}`}
      visible={player !== null}
      onHide={onClose}
      dismissableMask
      style={{ width: 400 }}
    >
      <div style={{ display: "grid", gap: 6, color: "var(--text-2)", marginBottom: 16 }}>
        {preview ? (
          <>
            <span>{t("market.valueLabel")}: <b style={{ color: "var(--gold-2)" }}>{money(preview.value)}</b></span>
            <span>{t("market.openingBaseLabel")}: <b style={{ color: "var(--gold-2)" }}>{money(preview.baseValue)}</b></span>
            <span>
              {t("market.allowedRangeLabel")}: <b style={{ color: "var(--gold-2)" }}>{money(preview.openingPriceRange.min)} – {money(preview.openingPriceRange.max)}</b>
            </span>
            <span style={{ fontSize: "0.86rem", color: "var(--text-3)" }}>
              {t("market.chooseOpening")}
            </span>
            <div style={{ marginTop: 8 }}>
              <InputNumber
                value={price}
                onValueChange={(e) => setPrice(e.value ?? 0)}
                min={preview.openingPriceRange.min}
                max={preview.openingPriceRange.max}
                mode="currency"
                currency="USD"
                locale={lang}
              />
            </div>
          </>
        ) : (
          <span>{t("market.loadingPreview")}</span>
        )}
      </div>
      {preview?.cooldownError && (
        <div className="card" style={{ marginBottom: 12, padding: 12, fontSize: "0.9rem", color: "var(--danger, #d66)" }}>
          {preview.cooldownError}
        </div>
      )}
      {preview?.alreadyListed && (
        <div className="card" style={{ marginBottom: 12, padding: 12, fontSize: "0.9rem", color: "var(--text-3)" }}>
          {t("market.alreadyListed")}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>{t("common.cancel")}</button>
        <button
          style={{ flex: 1 }}
          disabled={
            status?.paused ||
            !preview ||
            !!preview.cooldownError ||
            preview.alreadyListed ||
            price < preview.openingPriceRange.min ||
            price > preview.openingPriceRange.max
          }
          className={`btn${customTooltips && status?.paused ? " squad-tooltip-trigger" : ""}`}
          {...(customTooltips ? { "data-pr-tooltip": status?.paused ? SEASON_PAUSED_TITLE() : undefined } : { title: status?.paused ? SEASON_PAUSED_TITLE() : undefined })}
          onClick={() => void sell()}
        >
          {t("common.confirm")}
        </button>
      </div>
    </Dialog>
  );
}
