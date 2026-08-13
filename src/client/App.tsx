import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { ProjectsList } from "./components/ProjectsList";
import { ProjectDetail } from "./components/ProjectDetail";
import { NewPO } from "./components/NewPO";
import { NewPlantPO } from "./components/NewPlantPO";
import { POsList } from "./components/POsList";
import { POView } from "./components/POView";
import { ApprovalsInbox } from "./components/ApprovalsInbox";
import { Admin } from "./components/Admin";
import { DeletedProjects } from "./components/DeletedProjects";
import { ProductLibrary } from "./components/ProductLibrary";
import { SuppliersPage } from "./components/SuppliersPage";
import { Accounts } from "./components/Accounts";
import { DeliveriesWorkspace } from "./components/DeliveriesInbox";
import { QuoteReview } from "./components/QuoteReview";
import { AfpView } from "./components/AfpView";
import { ApplicationsWorkspace } from "./components/ApplicationsWorkspace";
import { CalendarPage } from "./components/Calendar";
import { ProgrammePortfolio } from "./components/ProgrammePortfolio";
import { Reports } from "./components/Reports";
import { GroupPage } from "./components/GroupPage";
import { ReportView } from "./components/ReportView";
import { SiteSignIn } from "./components/SiteSignIn";
import { OperativeProfile } from "./components/OperativeProfile";
import { RamsDevPage } from "./components/RamsDevPage";
import { QitpDashboard } from "./components/QitpDashboard";
import { QitpPrint } from "./components/QitpPrint";
import { CabinQitp } from "./components/CabinQitp";
import { Operatives } from "./components/Operatives";
import { OperativesBulkUpload } from "./components/OperativesBulkUpload";
import { OwnedPlantPage } from "./components/OwnedPlant";
import { Guide } from "./components/Guide";
import { WhatsNew } from "./components/WhatsNew";
// Lazy-loaded: the Dashboard pulls in Recharts (~100KB+). Code-splitting it
// keeps that weight out of the main bundle so it only loads when an admin
// actually opens /dashboard.
const Dashboard = lazy(() => import("./components/Dashboard").then((m) => ({ default: m.Dashboard })));
import { Sidebar } from "./components/Shell";
import { api } from "./lib/api";
import type { CurrentUser } from "../shared/types";
import { ROLES, ROLE_LABELS, type Role } from "../shared/permissions";

export function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  // Superadmin "view as" — preview the UI as another role (client-side role
  // override for the can() gating; the real auth is unchanged).
  const [viewAs, setViewAs] = useState<Role | null>(() => {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem("viewAsRole") : null;
    return v && (ROLES as string[]).includes(v) ? (v as Role) : null;
  });
  const location = useLocation();

  // Close the mobile nav drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  // The public operative sign-in page is reached by people who are NOT app
  // users (and isn't behind the app shell). Detect it before anything else and
  // render it standalone — no sidebar, no `me` fetch. Requires a Cloudflare
  // Access bypass on /site/* and /pub/* in production.
  const isPublicSite = location.pathname.startsWith("/site/") || location.pathname.startsWith("/operative/") || location.pathname.startsWith("/rams-dev") || location.pathname.startsWith("/cabin/");

  useEffect(() => {
    if (isPublicSite) return;
    api.me().then(setMe).catch((e) => setError(e.message));
  }, [isPublicSite]);

  // Refresh the approvals badge as the user moves around, but throttle it so
  // rapid navigation doesn't fire three list requests on every single click —
  // that background chatter was making the whole app feel sluggish. At most one
  // refresh per 15s; it still updates immediately when `me` first loads.
  const approvalsFetchedAt = useRef(0);
  useEffect(() => {
    if (!me?.is_approver) {
      setApprovalsCount(0);
      approvalsFetchedAt.current = 0;
      return;
    }
    if (Date.now() - approvalsFetchedAt.current < 15000) return;
    approvalsFetchedAt.current = Date.now();
    // Applications for payment no longer need director approval, so they no
    // longer contribute to the approvals badge — only POs and price approvals do.
    Promise.all([
      api.listPOs({ status: "pending_approval" }).catch(() => []),
      api.listPendingPriceApprovals().catch(() => []),
      api.listPendingSubstitutions().catch(() => []),
      api.listPendingUploads().catch(() => []),
    ])
      .then(([pos, prices, subs, uploads]) => {
        const isSuper = me.role === "superadmin";
        const minePOs = pos.filter((r) => isSuper || (r.approval_tier && me.approver_tiers.includes(r.approval_tier)));
        const minePrices = prices.filter((p) => isSuper || (p.approval_tier && me.approver_tiers.includes(p.approval_tier)));
        const mineSubs = subs.filter((s) => isSuper || (s.approval_tier && me.approver_tiers.includes(s.approval_tier)));
        // listPendingUploads returns [] for non-superadmins server-side.
        setApprovalsCount(minePOs.length + minePrices.length + mineSubs.length + uploads.length);
      })
      .catch(() => setApprovalsCount(0));
  }, [me, location.pathname]);

  // The role the UI gates on: a superadmin can override it via "view as".
  const isSuper = me?.role === "superadmin";
  const effectiveMe: CurrentUser | null = me && isSuper && viewAs && viewAs !== "superadmin" ? { ...me, role: viewAs } : me;
  function changeViewAs(r: Role | null) {
    if (r && r !== "superadmin") localStorage.setItem("viewAsRole", r);
    else localStorage.removeItem("viewAsRole");
    setViewAs(r);
  }

  // Standalone, un-authenticated operative sign-in — no sidebar, no shell.
  if (isPublicSite) {
    return (
      <Routes>
        <Route path="/site/:token" element={<SiteSignIn />} />
        <Route path="/operative/:token" element={<OperativeProfile />} />
        <Route path="/rams-dev" element={<RamsDevPage />} />
        <Route path="/cabin/:token" element={<CabinQitp />} />
      </Routes>
    );
  }

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <Sidebar me={effectiveMe} approvalsCount={approvalsCount} onNavigate={() => setNavOpen(false)} />
      <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
      <div className="app-main">
        <div className="mobile-topbar">
          <button className="nav-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>☰</button>
          <Link to="/" className="mobile-logo" aria-label="PGP Home"><img src="/logo.png" alt="PGP" /></Link>
        </div>
        {isSuper && (
          <div className={`viewas-bar${viewAs && viewAs !== "superadmin" ? " active" : ""}`}>
            <span className="viewas-label">View as</span>
            <select value={viewAs ?? "superadmin"} onChange={(e) => changeViewAs(e.target.value === "superadmin" ? null : (e.target.value as Role))}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            {viewAs && viewAs !== "superadmin" && (
              <span className="viewas-note">Previewing as <b>{ROLE_LABELS[viewAs]}</b> — commercial views hidden. <button className="viewas-exit" onClick={() => changeViewAs(null)}>Exit</button></span>
            )}
          </div>
        )}
        {error && (
          <div style={{ padding: "16px 28px" }}>
            <div className="flash error">{error}</div>
          </div>
        )}
        <Suspense fallback={<div className="empty" style={{ padding: 40 }}>Loading…</div>}>
          <Routes>
            <Route path="/" element={<ProjectsList me={effectiveMe} />} />
            <Route path="/dashboard" element={<Dashboard me={effectiveMe} />} />
            <Route path="/projects/:id" element={<ProjectDetail me={effectiveMe} />} />
            <Route path="/projects/:id/qitp" element={<QitpDashboard me={effectiveMe} />} />
            <Route path="/projects/:id/qitp/print" element={<QitpPrint />} />
            <Route path="/projects/:id/new-po" element={<NewPO />} />
            <Route path="/projects/:id/new-plant-po" element={<NewPlantPO />} />
            <Route path="/pos" element={<POsList me={effectiveMe} />} />
            <Route path="/pos/:id" element={<POView me={effectiveMe} />} />
            <Route path="/approvals" element={<ApprovalsInbox me={effectiveMe} />} />
            <Route path="/approvals/:id" element={<POView me={effectiveMe} />} />
            <Route path="/admin" element={<Admin me={effectiveMe} />} />
            <Route path="/deleted-projects" element={<DeletedProjects me={effectiveMe} />} />
            <Route path="/products" element={<ProductLibrary me={effectiveMe} />} />
            <Route path="/suppliers" element={<SuppliersPage me={effectiveMe} />} />
            <Route path="/accounts" element={<Accounts me={effectiveMe} />} />
            <Route path="/deliveries" element={<DeliveriesWorkspace me={effectiveMe} />} />
            <Route path="/operatives" element={<Operatives me={effectiveMe} />} />
            <Route path="/operatives/bulk-upload" element={<OperativesBulkUpload me={effectiveMe} />} />
            <Route path="/plant" element={<OwnedPlantPage me={effectiveMe} />} />
            <Route path="/quotes/:quoteId" element={<QuoteReview me={effectiveMe} />} />
            <Route path="/applications" element={<ApplicationsWorkspace me={effectiveMe} />} />
            <Route path="/applications/:id" element={<AfpView me={effectiveMe} />} />
            <Route path="/groups/:groupId" element={<GroupPage me={effectiveMe} />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/programme" element={<ProgrammePortfolio />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reports/:id" element={<ReportView />} />
            <Route path="/guide" element={<Guide me={effectiveMe} />} />
            <Route path="/whatsnew" element={<WhatsNew />} />
            <Route path="*" element={<NoMatch />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

function NoMatch() {
  return (
    <div style={{ padding: 48 }}>
      <div className="empty">Page not found. <Link to="/">Back to projects</Link></div>
    </div>
  );
}
