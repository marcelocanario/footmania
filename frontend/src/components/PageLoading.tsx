import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export function PageLoading({ message }: { message?: string }) {
  const { t } = useTranslation();
  const text = message ?? t("pageLoading.default");
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <div className="page-loading-card">
        <div className="page-loading-spinner"><LoaderCircle size={26} /></div>
        <strong>{text}</strong>
        <span>{t("pageLoading.preparing")}</span>
      </div>
    </div>
  );
}
