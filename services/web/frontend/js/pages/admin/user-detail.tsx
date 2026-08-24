import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  getJSON,
  putJSON,
  postJSON,
  deleteJSON,
} from "@/infrastructure/fetch-json";

type AuditEntry = {
  _id: string;
  action: string;
  actorId?: string;
  info?: Record<string, unknown>;
  ipAddress?: string;
  timestamp: string;
};

type UserDetails = {
  user: {
    _id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    isAdmin?: boolean;
    suspended?: boolean;
    lastLoggedIn?: string;
    lastLoginIp?: string;
    loginCount?: number;
    signUpDate?: string;
  };
  projectCount: number;
};

function userIdFromPath() {
  const match = window.location.pathname.match(
    /\/admin\/users\/([a-f0-9]{24})/,
  );
  return match ? match[1] : null;
}

function UserDetail() {
  const userId = userIdFromPath();
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    getJSON<UserDetails>(`/admin/api/users/${userId}`).then(setDetails);
    getJSON<{ entries: AuditEntry[] }>(
      `/admin/api/audit?targetType=user&targetId=${userId}&limit=50`,
    ).then((data) => setAudit(data.entries));
  }, [userId]);

  if (!details || !userId) {
    return <p>Loading…</p>;
  }

  const { user, projectCount } = details;

  async function toggleSuspended() {
    await putJSON(`/admin/api/users/${userId}`, {
      body: { suspended: !user.suspended },
    });
    setMessage(user.suspended ? "User enabled" : "User suspended");
    getJSON<UserDetails>(`/admin/api/users/${userId}`).then(setDetails);
  }

  async function toggleAdmin() {
    await putJSON(`/admin/api/users/${userId}`, {
      body: { isAdmin: !user.isAdmin },
    });
    setMessage("Admin flag updated");
    getJSON<UserDetails>(`/admin/users/${userId}`).then(setDetails);
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    await postJSON(`/admin/api/users/${userId}/password`, {
      body: { newPassword },
    });
    setNewPassword("");
    setMessage("Password updated");
  }

  async function deleteUser() {
    if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    await deleteJSON(
      `/admin/api/users/${userId}?confirm=${encodeURIComponent(user.email)}`,
    );
    setMessage("Deletion started");
  }

  return (
    <div>
      <h1>{user.email}</h1>
      <p>
        <a href="/admin/users">Back to users</a>
      </p>
      {message ? <p className="alert alert-info">{message}</p> : null}
      <table className="table">
        <tbody>
          <tr>
            <th>Name</th>
            <td>
              {[user.first_name, user.last_name].filter(Boolean).join(" ")}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td>{user.suspended ? "Suspended" : "Active"}</td>
          </tr>
          <tr>
            <th>Site admin</th>
            <td>{user.isAdmin ? "Yes" : "No"}</td>
          </tr>
          <tr>
            <th>Projects</th>
            <td>{projectCount}</td>
          </tr>
          <tr>
            <th>Last login</th>
            <td>
              {user.lastLoggedIn || "—"}{" "}
              {user.lastLoginIp ? `(${user.lastLoginIp})` : ""}
            </td>
          </tr>
          <tr>
            <th>Signed up</th>
            <td>{user.signUpDate || "—"}</td>
          </tr>
        </tbody>
      </table>
      <button className="btn btn-default" onClick={toggleSuspended}>
        {user.suspended ? "Enable account" : "Disable account"}
      </button>{" "}
      <button className="btn btn-default" onClick={toggleAdmin}>
        {user.isAdmin ? "Revoke admin" : "Make admin"}
      </button>{" "}
      <button className="btn btn-danger" onClick={deleteUser}>
        Delete account
      </button>
      <h2>Set password</h2>
      <form onSubmit={resetPassword} className="form-inline">
        <input
          type="password"
          className="form-control"
          value={newPassword}
          minLength={8}
          placeholder="New password"
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />{" "}
        <button type="submit" className="btn btn-primary">
          Update password
        </button>
      </form>
      <h2>Audit trail</h2>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Actor</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((entry) => (
            <tr key={entry._id}>
              <td>{entry.timestamp}</td>
              <td>{entry.action}</td>
              <td>{entry.actorId || "system"}</td>
              <td>{entry.ipAddress || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const element = document.getElementById("admin-user-detail-root");
if (element) {
  createRoot(element).render(<UserDetail />);
}
