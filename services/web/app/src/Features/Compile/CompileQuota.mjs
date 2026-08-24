import Settings from "@overleaf/settings";
import { User } from "../../models/User.mjs";
import { CompileJob } from "../../models/CompileJob.mjs";

// Daily compile quota per user (PLANS 3 "Resource quotas"). Admins
// bypass the check (admin override). Limit configurable via
// Settings.compileQuotaPerUserPerDay.
export async function checkCompileQuota(userId) {
  const quota = Settings.compileQuotaPerUserPerDay || 200;
  const user = await User.findOne({ _id: userId }, { isAdmin: 1 }).lean();
  if (user?.isAdmin === true) {
    return { ok: true, quota, used: null, adminOverride: true };
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await CompileJob.countDocuments({
    userId,
    queuedAt: { $gte: startOfDay },
  });
  return { ok: used < quota, quota, used, adminOverride: false };
}
