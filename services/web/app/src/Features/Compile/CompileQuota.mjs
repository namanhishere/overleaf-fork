import Settings from "@overleaf/settings";

// Daily compile quota per user (PLANS 3 "Resource quotas"). Admins
// bypass the check (admin override). Limit configurable via
// Settings.compileQuotaPerUserPerDay.
//
// Models are loaded lazily so that importing this module (via
// CompileManager) never pulls Mongoose into contexts that stub the
// models - e.g. upstream unit tests.
export async function checkCompileQuota(userId) {
  const [{ User }, { CompileJob }] = await Promise.all([
    import("../../models/User.mjs"),
    import("../../models/CompileJob.mjs"),
  ]);
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
