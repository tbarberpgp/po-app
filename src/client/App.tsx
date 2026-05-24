import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ProjectsList } from "./components/ProjectsList";
import { ProjectDetail } from "./components/ProjectDetail";
import { NewPO } from "./components/NewPO";
import { POsList } from "./components/POsList";
import { POView } from "./components/POView";
import { ApprovalsInbox } from "./components/ApprovalsInbox";
import { Admin } from "./components/Admin";
import { api } from "./lib/api";
import type { CurrentUser } from "../shared/types";

export function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    api.me().then(setMe).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>PowerGrid POs</h1>
        <nav>
          <NavLink to="/" end>Projects</NavLink>
          <NavLink to="/pos">Purchase Orders</NavLink>
          {me?.is_approver && <NavLink to="/approvals">Approvals</NavLink>}
          <NavLink to="/admin">Admin</NavLink>
        </nav>
        <div style={{ flex: 1 }} />
        {me && (
          <div className="user">
            Signed in as<br />
            <b>{me.email}</b>
            {me.is_approver && (
              <div style={{ marginTop: 4 }}>
                Approver: {me.approver_tiers.join(", ")}
              </div>
            )}
          </div>
        )}
      </aside>
      <main key={location.pathname}>
        {error && <div className="flash error">{error}</div>}
        <Routes>
          <Route path="/" element={<ProjectsList />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/new-po" element={<NewPO />} />
          <Route path="/pos" element={<POsList />} />
          <Route path="/pos/:id" element={<POView me={me} />} />
          <Route path="/approvals" element={<ApprovalsInbox me={me} />} />
          <Route path="/approvals/:id" element={<POView me={me} />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<NoMatch />} />
        </Routes>
      </main>
    </div>
  );
}

function NoMatch() {
  return (
    <div className="empty">
      Page not found. <Link to="/">Back to projects</Link>
    </div>
  );
}
