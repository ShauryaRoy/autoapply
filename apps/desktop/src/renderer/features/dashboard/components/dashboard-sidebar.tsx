import { BriefcaseBusiness, ClipboardList, LayoutDashboard, ListChecks, Settings, UserRound } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "../../../components/ui/button.js";
import { Card } from "../../../components/ui/card.js";

type DashboardSidebarProps = {
  userName: string;
  userEmail: string;
  activeItem?: "Apply" | "Applications" | "Jobs" | "Profile" | "Settings" | "Tracker";
  onNavigateApply?: () => void;
  onNavigateApplications?: () => void;
  onNavigateJobs?: () => void;
  onNavigateProfile?: () => void;
  onNavigateSettings?: () => void;
  onNavigateTracker?: () => void;
  onLogout: () => void;
};

const navItems: Array<{
  key: "Apply" | "Applications" | "Tracker" | "Jobs" | "Profile" | "Settings";
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: "Apply", label: "Dashboard", icon: LayoutDashboard },
  { key: "Applications", label: "Applications", icon: ClipboardList },
  { key: "Tracker", label: "Tracker", icon: ListChecks },
  { key: "Jobs", label: "Jobs", icon: BriefcaseBusiness },
  { key: "Profile", label: "Profile", icon: UserRound },
  { key: "Settings", label: "Settings", icon: Settings }
];

export function DashboardSidebar({
  userName,
  userEmail,
  activeItem = "Apply",
  onNavigateApply,
  onNavigateApplications,
  onNavigateJobs,
  onNavigateProfile,
  onNavigateSettings,
  onNavigateTracker,
  onLogout
}: DashboardSidebarProps) {
  const handleItemClick = (label: "Apply" | "Applications" | "Tracker" | "Jobs" | "Profile" | "Settings") => {
    if (label === "Apply") onNavigateApply?.();
    if (label === "Applications") onNavigateApplications?.();
    if (label === "Tracker") onNavigateTracker?.();
    if (label === "Jobs") onNavigateJobs?.();
    if (label === "Profile") onNavigateProfile?.();
    if (label === "Settings") onNavigateSettings?.();
  };

  return (
    <aside className="flex min-h-screen w-[272px] flex-col border-r border-slate-200 bg-white px-4 py-6">
      <div className="mb-8 px-2">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">AutoApply</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">AutoApply</h1>
      </div>

      <nav className="space-y-1">
        {navItems.map((item, idx) => (
          <motion.button
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.05 }}
            key={item.key}
            className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
              item.key === activeItem
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
            type="button"
            onClick={() => handleItemClick(item.key)}
          >
            <item.icon size={16} className={item.key === activeItem ? "text-white" : "text-slate-500 group-hover:text-slate-900"} />
            {item.label}
          </motion.button>
        ))}
      </nav>

      <Card className="mt-auto space-y-3 p-4">
        <p className="text-sm font-medium text-slate-900">{userName}</p>
        <p className="text-xs text-slate-500">{userEmail}</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onNavigateProfile} className="flex-1">
            Profile
          </Button>
          <Button variant="danger" size="sm" onClick={onLogout} className="flex-1">
            Logout
          </Button>
        </div>
      </Card>
    </aside>
  );
}
