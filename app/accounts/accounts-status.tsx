import { AccountsSkeleton } from "@/app/components/page-skeletons";
import { buttonClassName } from "@/app/components/button-styles";
import "./accounts.css";

export function AccountsLoading() {
  return <AccountsSkeleton />;
}

export function AccountsErrorState({ message, onRetry, title = "Alfred could not load your accounts.", retryLabel = "Retry" }: { message: string; onRetry?: () => void; title?: string; retryLabel?: string }) {
  return <div className="alfred-accounts"><div className="alfred-accounts-heading"><div><p className="alfred-accounts-eyebrow">Your money, accounted for</p><h1>Accounts</h1></div></div><section className="alfred-accounts-loadError" role="alert"><h2>{title}</h2><p>{message}</p>{onRetry ? <button className={buttonClassName({ variant: "primary", className: "alfred-accounts-primary" })} onClick={onRetry}>{retryLabel}</button> : null}</section></div>;
}
