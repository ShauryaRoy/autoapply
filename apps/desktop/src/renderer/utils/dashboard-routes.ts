export type DashboardRoute =
  | { kind: "onboarding" }
  | { kind: "list" }
  | { kind: "detail"; jobId: string };

const DETAIL_ROUTE = /^\/dashboard\/job\/([^/]+)$/;

export function getDashboardRoute(pathname: string): DashboardRoute {
  if (pathname.startsWith("/onboarding")) {
    return { kind: "onboarding" };
  }

  const match = DETAIL_ROUTE.exec(pathname);
  if (!match) return { kind: "list" };

  const decodedJobId = decodeURIComponent(match[1] ?? "");
  if (!decodedJobId) return { kind: "list" };

  return { kind: "detail", jobId: decodedJobId };
}

export function navigateToJobDetail(jobId: string): void {
  const nextPath = `/dashboard/job/${encodeURIComponent(jobId)}`;
  window.history.pushState({ jobId }, "", nextPath);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToDashboardList(): void {
  window.history.pushState({}, "", "/dashboard");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
