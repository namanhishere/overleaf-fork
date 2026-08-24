import PrivilegeLevels from "./PrivilegeLevels.mjs";

/**
 * Canonical project role names for APIs and UI, mapped onto the legacy
 * privilege levels stored on the Project document. The privilege strings
 * remain the storage format; role names are the stable external contract.
 *
 * Global roles (documented contract, no separate schema):
 * - System Admin   == User.isAdmin (existing site-admin gate)
 * - Researcher     == plain registered user
 * - Organization Admin arrives with organizations in Phase 3.
 */
const ROLE_TO_PRIVILEGE_LEVEL = {
  owner: PrivilegeLevels.OWNER,
  editor: PrivilegeLevels.READ_AND_WRITE,
  commenter: PrivilegeLevels.REVIEW,
  viewer: PrivilegeLevels.READ_ONLY,
};

const PRIVILEGE_LEVEL_TO_ROLE = Object.fromEntries(
  Object.entries(ROLE_TO_PRIVILEGE_LEVEL).map(([role, level]) => [level, role]),
);

/**
 * Normalize user-supplied input to a privilege level string. Accepts both
 * canonical role names ('editor') and legacy privilege levels
 * ('readAndWrite'). Returns null when unrecognized.
 */
function toPrivilegeLevel(input) {
  if (typeof input !== "string") return null;
  if (PRIVILEGE_LEVEL_TO_ROLE[input] != null) return input;
  return ROLE_TO_PRIVILEGE_LEVEL[input] ?? null;
}

function roleForPrivilegeLevel(level) {
  return PRIVILEGE_LEVEL_TO_ROLE[level] ?? null;
}

export default {
  ROLE_TO_PRIVILEGE_LEVEL,
  PRIVILEGE_LEVEL_TO_ROLE,
  toPrivilegeLevel,
  roleForPrivilegeLevel,
};
