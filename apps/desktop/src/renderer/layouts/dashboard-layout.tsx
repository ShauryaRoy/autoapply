import type { ReactNode } from "react";

type DashboardLayoutProps = {
  sidebar: ReactNode;
  leftRail: ReactNode;
  main: ReactNode;
  hideLeftRail?: boolean;
  children?: ReactNode;
};

export function DashboardLayout({ sidebar, leftRail, main, hideLeftRail = false, children }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="relative flex min-h-screen">
        {sidebar}
        <div className={`mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 px-4 py-6 lg:px-6 ${hideLeftRail ? "" : "lg:grid-cols-[340px_minmax(0,1fr)]"}`}>
          {!hideLeftRail ? <div>{leftRail}</div> : null}
          <main className="space-y-6">{main}</main>
        </div>
      </div>
      {children}
    </div>
  );
}
