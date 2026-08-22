import { LoaderCircle } from "lucide-react";

export function PageLoading({ message = "Loading your club" }: { message?: string }) {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <div className="page-loading-card">
        <div className="page-loading-spinner"><LoaderCircle size={26} /></div>
        <strong>{message}</strong>
        <span>Preparing the next page</span>
      </div>
    </div>
  );
}
