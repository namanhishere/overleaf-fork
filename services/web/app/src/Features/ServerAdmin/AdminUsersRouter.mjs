import AuthenticationController from "../Authentication/AuthenticationController.mjs";
import AuthorizationMiddleware from "../Authorization/AuthorizationMiddleware.mjs";
import { RateLimiter } from "../../infrastructure/RateLimiter.mjs";
import RateLimiterMiddleware from "../Security/RateLimiterMiddleware.mjs";
import AdminUsersController from "./AdminUsersController.mjs";
import AdminJobsController from "../Admin/AdminJobsController.mjs";
import AdminWorkersController from "../Admin/AdminWorkersController.mjs";

const rateLimiters = {
  adminUsersRead: new RateLimiter("admin-users-read", {
    points: 120,
    duration: 60,
  }),
  adminUsersWrite: new RateLimiter("admin-users-write", {
    points: 30,
    duration: 60,
  }),
  adminJobsRead: new RateLimiter("admin-jobs-read", {
    points: 120,
    duration: 60,
  }),
};

export default {
  apply(webRouter, privateApiRouter) {
    const requireSiteAdmin = [
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
    ];

    // --- Admin user management (JSON API) ---
    webRouter.get(
      "/admin/api/users/search",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersRead),
      AdminUsersController.searchUsers,
    );
    webRouter.get(
      "/admin/api/users/:userId",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersRead),
      AdminUsersController.getUser,
    );
    webRouter.put(
      "/admin/api/users/:userId",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersWrite),
      AdminUsersController.patchUser,
    );
    webRouter.post(
      "/admin/api/users/:userId/password",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersWrite),
      AdminUsersController.setPassword,
    );
    webRouter.delete(
      "/admin/api/users/:userId",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersWrite),
      AdminUsersController.deleteUser,
    );

    // --- Compile job administration ---
    webRouter.get(
      "/admin/api/jobs",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminJobsRead),
      AdminJobsController.listJobs,
    );
    webRouter.post(
      "/admin/api/jobs/:jobId/kill",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersWrite),
      AdminJobsController.killJob,
    );
    webRouter.post(
      "/admin/api/jobs/:jobId/retry",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminUsersWrite),
      AdminJobsController.retryJob,
    );
    webRouter.get(
      "/admin/api/jobs/:jobId/log",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminJobsRead),
      AdminJobsController.getJobLog,
    );

    // --- Worker health registry ---
    webRouter.get(
      "/admin/api/workers",
      ...requireSiteAdmin,
      RateLimiterMiddleware.rateLimit(rateLimiters.adminJobsRead),
      AdminWorkersController.listWorkers,
    );
  },
};
