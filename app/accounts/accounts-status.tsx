import { Skeleton } from "@/app/components/status";
import { buttonClassName } from "@/app/components/button-styles";
import "./accounts.css";

export function AccountsLoading() {
  return <div className="alfred-accounts alfred-accounts-loading" aria-busy="true">
    <div className="alfred-accounts-heading"><div><p className="alfred-accounts-eyebrow">Your money, accounted for</p><h1>Accounts</h1><p>Balances, movements and the records that connect them.</p></div></div>
    <p role="status" className="sr-only">Loading your account records…</p>
    <div className="alfred-accounts-summary" aria-hidden="true"><div><Skeleton className="alfred-accounts-skeletonLabel" /><Skeleton className="alfred-accounts-skeletonBalance" /><Skeleton className="alfred-accounts-skeletonText" /></div><div><Skeleton className="alfred-accounts-skeletonLabel" /><Skeleton className="alfred-accounts-skeletonNumber" /></div></div>
    <div className="alfred-accounts-loadingTabs" aria-hidden="true">{[0,1,2,3].map((index) => <Skeleton key={index} />)}</div>
    <div className="alfred-accounts-grid" aria-hidden="true">{[0,1].map((index) => <div className="alfred-account-card" key={index}><Skeleton className="alfred-accounts-skeletonLabel" /><Skeleton className="alfred-accounts-skeletonBalance" /><Skeleton className="alfred-accounts-skeletonText" /><Skeleton className="alfred-accounts-skeletonEvidence" /></div>)}</div>
  </div>;
}

export function AccountsErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="alfred-accounts"><div className="alfred-accounts-heading"><div><p className="alfred-accounts-eyebrow">Your money, accounted for</p><h1>Accounts</h1></div></div><section className="alfred-accounts-loadError" role="alert"><h2>Alfred could not load your accounts.</h2><p>{message}</p>{onRetry ? <button className={buttonClassName({ variant: "primary", className: "alfred-accounts-primary" })} onClick={onRetry}>Retry</button> : null}</section></div>;
}
