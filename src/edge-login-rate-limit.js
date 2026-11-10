export async function checkEdgeLoginRateLimit(env, ipHash) {
  const ipLimiter = env?.LOGIN_EDGE_IP_LIMITER;
  const globalLimiter = env?.LOGIN_EDGE_GLOBAL_LIMITER;
  if (!ipLimiter || !globalLimiter || typeof ipHash !== "string" || !ipHash) {
    return { available: false, allowed: false };
  }
  try {
    const [ipResult, globalResult] = await Promise.all([
      ipLimiter.limit({ key: "owner-login:ip:" + ipHash }),
      globalLimiter.limit({ key: "owner-login:global" })
    ]);
    return {
      available: true,
      allowed: ipResult?.success === true && globalResult?.success === true
    };
  } catch {
    return { available: false, allowed: false };
  }
}
