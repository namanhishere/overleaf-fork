import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, putJSON } from "@/infrastructure/fetch-json";

type AdminUser = {
  _id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  isAdmin?: boolean;
  suspended?: boolean;
  lastLoggedIn?: string;
  signUpDate?: string;
};

function UsersTable() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(q: string) {
    setError(null);
    try {
      const data = await getJSON<{ users: AdminUser[]; total: number }>(
        `/admin/api/users/search?q=${encodeURIComponent(q)}&limit=50`,
      );
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  useEffect(() => {
    runSearch("");
  }, []);

  async function toggleSuspended(user: AdminUser) {
    await putJSON(`/admin/users/${user._id}`, {
      body: { suspended: !user.suspended },
    });
    runSearch(query);
  }

  async function toggleAdmin(user: AdminUser) {
    await putJSON(`/admin/users/${user._id}`, {
      body: { isAdmin: !user.isAdmin },
    });
    runSearch(query);
  }

  return (
    <div>
      <h1>Users</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/jobs">Jobs</a> ·{" "}
        <a href="/admin/workers">Workers</a> · <a href="/admin/audit">Audit</a>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(query);
        }}
      >
        <input
          type="text"
          value={query}
          placeholder="Search by email or name"
          onChange={(e) => setQuery(e.target.value)}
        />{" "}
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
      {error ? <p className="text-danger">{error}</p> : null}
      <p>
        {total} user{total === 1 ? "" : "s"} found
      </p>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Status</th>
            <th>Admin</th>
            <th>Last login</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user._id}>
              <td>
                <a href={`/admin/users/${user._id}`}>{user.email}</a>
              </td>
              <td>
                {[user.first_name, user.last_name].filter(Boolean).join(" ")}
              </td>
              <td>{user.suspended ? "Suspended" : "Active"}</td>
              <td>{user.isAdmin ? "Yes" : "No"}</td>
              <td>{user.lastLoggedIn || "—"}</td>
              <td>
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => toggleSuspended(user)}
                >
                  {user.suspended ? "Enable" : "Disable"}
                </button>{" "}
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => toggleAdmin(user)}
                >
                  {user.isAdmin ? "Revoke admin" : "Make admin"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const element = document.getElementById("admin-users-root");
if (element) {
  createRoot(element).render(<UsersTable />);
}
