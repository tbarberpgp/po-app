import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTheme } from "../lib/theme";
import type { CurrentUser } from "../../shared/types";
import { can, ROLES, ROLE_LABELS, type Role } from "../../shared/permissions";
import { WHATS_NEW_LATEST_ID } from "../lib/whats-new";

// Line icons (Lucide-style: 24×24 viewBox, currentColor stroke) keyed by nav
// item. Kept inline so the sidebar has no icon-library dependency.
const ICON_PATHS: Record<string, ReactNode> = {
  projects: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
  programme: <><path d="M8 6h11" /><path d="M6 12h9" /><path d="M11 18h7" /></>,
  reports: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5" /><path d="M8 13h8" /><path d="M8 17h5" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18" /><path d="M8 2v4" /><path d="M16 2v4" /></>,
  applications: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6" /><path d="M9 16h4" /></>,
  pos: <><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></>,
  deliveries: <><path d="M12 3v9" /><path d="m8 8 4 4 4-4" /><path d="M3 13h5l1.5 3h5l1.5-3h5" /><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" /></>,
  accounts: <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>,
  menu: <><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /></>,
  approvals: <polyline points="20 6 9 17 4 12" />,
  dashboard: <><line x1="6" y1="20" x2="6" y2="14" /><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /></>,
  operatives: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><polyline points="16 11 18 13 22 9" /></>,
  plant: <><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.6a1 1 0 0 0-.2-.6l-3.5-4.4a1 1 0 0 0-.8-.4H14" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  products: <><path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  suppliers: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></>,
  admin: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
  deleted: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>,
  guide: <><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  viewas: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  whatsnew: <polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2" />,
};

function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg className="nav-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

/** Collapsible sidebar section. Open/closed state persists per id so the
 *  layout a user sets up survives reloads. */
function NavSection({ id, label, onNavigate, children }: { id: string; label: string; onNavigate?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`sidebar.sec.${id}`) !== "0"; } catch { return true; }
  });
  function toggle() {
    setOpen((o) => {
      const next = !o;
      try { localStorage.setItem(`sidebar.sec.${id}`, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }
  return (
    <div className={`nav-sec${open ? "" : " collapsed"}`}>
      <button type="button" className="nav-sec-hd" onClick={toggle} aria-expanded={open}>
        <span>{label}</span>
        <svg className="nav-sec-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && <nav onClick={onNavigate}>{children}</nav>}
    </div>
  );
}

export function Sidebar({ me, approvalsCount, onNavigate, onHide, viewAs }: { me: CurrentUser | null; approvalsCount: number; onNavigate?: () => void; onHide?: () => void; viewAs?: { role: Role; onChange: (r: Role) => void } }) {
  // Permission checks take the whole user, not just the role: a per-user grant
  // has to reach the nav, or a page someone was granted stays hidden from them.
  // `isAdmin` below is a genuine question about rank, so it keeps the role.
  const role = me?.role;
  const canDeliveryEdit = can(me, "delivery.edit");
  const canCommercialView = can(me, "commercial.view");
  const canManageData = can(me, "users.read") || can(me, "approvers.manage");
  const isAdmin = role === "admin" || role === "superadmin";

  // Master data + Admin share one section; the header names whichever halves
  // the user can actually see (so a Site user sees just "Master data").
  const canViewMasterData = can(me, "masterdata.read"); // everyone — read-only reference lists
  const showDashboard = isAdmin && can(me, "users.read");
  const showAdmin = isAdmin && canManageData;
  const showDeleted = isAdmin && can(me, "projects.delete");
  const hasMaster = canViewMasterData;
  const hasAdmin = showDashboard || showAdmin || showDeleted;
  const dataLabel = [hasMaster && "Master data", hasAdmin && "Admin"].filter(Boolean).join(" · ");

  // Red dot next to "What's new" until the user opens the changelog. Recomputed
  // when WhatsNew dispatches "whatsnew-seen" so the dot clears immediately.
  const [whatsNewUnseen, setWhatsNewUnseen] = useState(false);
  useEffect(() => {
    const read = () => {
      try { setWhatsNewUnseen(localStorage.getItem("whatsnew.seen") !== WHATS_NEW_LATEST_ID); }
      catch { setWhatsNewUnseen(false); }
    };
    read();
    window.addEventListener("whatsnew-seen", read);
    return () => window.removeEventListener("whatsnew-seen", read);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {onHide && (
          <button type="button" className="nav-menu-btn" onClick={onHide} aria-label="Hide menu" title="Hide menu">
            <Icon name="menu" />
          </button>
        )}
        <Link to="/" className="sidebar-logo" aria-label="PGP Home" onClick={onNavigate}>
          <img src="/logo.png" alt="PGP" />
        </Link>
      </div>

      <NavSection id="delivery" label="Delivery" onNavigate={onNavigate}>
        <NavLink to="/" end><Icon name="projects" /><span>Projects</span></NavLink>
        <NavLink to="/programme"><Icon name="programme" /><span>Programme</span></NavLink>
        <NavLink to="/deliveries"><Icon name="deliveries" /><span>Deliveries</span></NavLink>
        {canDeliveryEdit && <NavLink to="/reports"><Icon name="reports" /><span>Reports</span></NavLink>}
      </NavSection>

      <NavSection id="commercial" label="Commercial" onNavigate={onNavigate}>
        {canCommercialView && <NavLink to="/calendar"><Icon name="calendar" /><span>Calendar</span></NavLink>}
        {canCommercialView && <NavLink to="/applications"><Icon name="applications" /><span>Applications</span></NavLink>}
        {canCommercialView && <NavLink to="/accounts"><Icon name="accounts" /><span>Accounts</span></NavLink>}
        <NavLink to="/pos"><Icon name="pos" /><span>Purchase Orders</span></NavLink>
        {/* Two separate authorities land on this page: PO approval tiers, and
            the invoice release allowlist. Someone can hold either alone. */}
        {(me?.is_approver || me?.can_release_payables) && (
          <NavLink to="/approvals">
            <Icon name="approvals" /><span>Approvals</span>
            {approvalsCount > 0 && <span className="badge-count">{approvalsCount}</span>}
          </NavLink>
        )}
      </NavSection>

      {(hasMaster || hasAdmin) && (
        <NavSection id="data" label={dataLabel} onNavigate={onNavigate}>
          {canViewMasterData && <NavLink to="/operatives"><Icon name="operatives" /><span>Operatives</span></NavLink>}
          {canViewMasterData && <NavLink to="/plant"><Icon name="plant" /><span>Plant register</span></NavLink>}
          {canViewMasterData && <NavLink to="/products"><Icon name="products" /><span>Product library</span></NavLink>}
          {canViewMasterData && <NavLink to="/suppliers"><Icon name="suppliers" /><span>Approved suppliers</span></NavLink>}
          {showDashboard && <NavLink to="/dashboard"><Icon name="dashboard" /><span>Dashboard</span></NavLink>}
          {showAdmin && <NavLink to="/admin"><Icon name="admin" /><span>Admin</span></NavLink>}
          {showDeleted && <NavLink to="/deleted-projects"><Icon name="deleted" /><span>Deleted projects</span></NavLink>}
        </NavSection>
      )}

      <div style={{ flex: 1 }} />

      {/* Help & changelog — sits below the working nav, above the user chip. */}
      <nav className="sidebar-foot" onClick={onNavigate}>
        <NavLink to="/guide"><Icon name="guide" /><span>Guide &amp; help</span></NavLink>
        <NavLink to="/whatsnew">
          <Icon name="whatsnew" /><span>What's new</span>
          {whatsNewUnseen && <span className="nav-dot" aria-label="New updates" />}
        </NavLink>
      </nav>
      {/* Superadmin role preview, styled as one more row. Outside the <nav>
          above so opening it doesn't close the phone drawer. */}
      {viewAs && (
        <label className="nav-viewas">
          <Icon name="viewas" /><span>View as</span>
          <select value={viewAs.role} onChange={(e) => viewAs.onChange(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </label>
      )}


      {me && (
        <div className="sidebar-user">
          <div className="avatar">{initials(me.name ?? me.email)}</div>
          <div className="meta">
            <div className="name">{me.name?.trim() || nameFromEmail(me.email)}</div>
            <div className="role">
              {ROLE_LABELS[me.role]}
              {me.is_approver && " · Approver"}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/** Shown in place of a hidden sidebar: the same three-line button, top left. */
export function ShowMenuButton({ onShow }: { onShow: () => void }) {
  return (
    <button type="button" className="nav-menu-btn nav-show-btn" onClick={onShow} aria-label="Show menu" title="Show menu">
      <Icon name="menu" />
    </button>
  );
}

export function Topbar({
  crumbs,
  title,
  status,
  actions,
}: {
  crumbs?: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  // Publish the topbar's height so in-page bars (.sticky-bar) can stick just
  // under it rather than sliding beneath it. It wraps on narrow screens, so
  // it's measured, not hard-coded.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--topbar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--topbar-h"); };
  }, []);
  return (
    <header className="topbar" ref={ref}>
      <div className="title-block">
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>
          {title}
          {status && <span style={{ marginLeft: 4 }}>{status}</span>}
        </h1>
      </div>
      <div className="actions">{actions}</div>
      <ThemeToggle />
    </header>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        type="button"
        className={theme === "light" ? "active" : ""}
        onClick={() => setTheme("light")}
        title="Light theme"
      >
        Light
      </button>
      <button
        type="button"
        className={theme === "dark" ? "active" : ""}
        onClick={() => setTheme("dark")}
        title="Dark theme"
      >
        Dark
      </button>
    </div>
  );
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || "??").toUpperCase();
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}
