import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { ProjectsList } from "./components/ProjectsList";
import { ProjectDetail } from "./components/ProjectDetail";
import { NewPO } from "./components/NewPO";
import { POsList } from "./components/POsList";
import { POView } from "./components/POView";
import { ApprovalsInbox } from "./components/ApprovalsInbox";
import { Admin } from "./components/Admin";
import { DeletedProjects } from "./components/DeletedProjects";
import { Sidebar } from "./components/Shell";
import { api } from "./lib/api";
import type { CurrentUser } from "../shared/types";

export function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    api.me().then(setMe).catch((e) => setError(e.message));
  }, []);

  // Refresh approvals count whenever the user navigates — cheap and accurate.
  useEffect(() => {
    if (!me?.is_approver) {
      setApprovalsCount(0);
      return;
    }
    api
      .listPOs({ status: "pending_approval" })
      .then((rs) => {
        const mine = rs.filter((r) => r.approval_tier && me.approver_tiers.includes(r.approval_tier));
        setApprovalsCount(mine.length);
      })
      .catch(() => setApprovalsCount(0));
  }, [me, location.pathname]);

  return (
    <div className="app">
      <Sidebar me={me} approvalsCount={approvalsCount} />
      <div>
        {error && (
          <div style={{ padding: "16px 28px" }}>
            <div className="flash error">{error}</div>
          </div>
        )}
        <Routes>
          <Route path="/" element={<ProjectsList me={me} />} />
          <Route path="/projects/:id" element={<ProjectDetail me={me} />} />
          <Route path="/projects/:id/new-po" element={<NewPO />} />
          <Route path="/pos" element={<POsList />} />
          <Route path="/pos/:id" element={<POView me={me} />} />
          <Route path="/approvals" element={<ApprovalsInbox me={me} />} />
          <Route path="/approvals/:id" element={<POView me={me} />} />
          <Route path="/admin" element={<Admin me={me} />} />
          <Route path="/deleted-projects" element={<DeletedProjects me={me} />} />
          <Route path="*" element={<NoMatch />} />
        </Routes>
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
