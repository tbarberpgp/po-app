import { type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTheme } from "../lib/theme";
import type { CurrentUser } from "../../shared/types";
import { can, ROLE_LABELS } from "../../shared/permissions";

export function Sidebar({ me, approvalsCount }: { me: CurrentUser | null; approvalsCount: number }) {
  return (
    <aside className="sidebar">
      <Link to="/" className="sidebar-logo" aria-label="PGP Home">
        <img src="/logo.png" alt="PGP" />
      </Link>

      <div className="sidebar-group">
        <div className="sidebar-group-label">Workspace</div>
        <nav>
          <NavLink to="/" end>Projects</NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/pos">Purchase Orders</NavLink>
          {me?.is_approver && (
            <NavLink to="/approvals">
              Approvals
              {approvalsCount > 0 && <span className="badge-count">{approvalsCount}</span>}
            </NavLink>
          )}
        </nav>
      </div>

      {(can(me?.role, "users.read") || can(me?.role, "approvers.manage")) && (
        <div className="sidebar-group">
          <div className="sidebar-group-label">Master Data</div>
          <nav>
            <NavLink to="/products">Product library</NavLink>
            <NavLink to="/suppliers">Approved suppliers</NavLink>
            <NavLink to="/admin">Admin</NavLink>
            {can(me?.role, "projects.delete") && (
              <NavLink to="/deleted-projects">Deleted projects</NavLink>
            )}
          </nav>
        </div>
      )}

      <div style={{ flex: 1 }} />

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
  return (
    <header className="topbar">
      <div className="title-block">
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>
          {title}
          {status && <span style={{ marginLeft: 4 }}>{status}</span>}
        </h1>
      </div>
      <div className="actions">{actions}<ThemeToggle /></div>
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
