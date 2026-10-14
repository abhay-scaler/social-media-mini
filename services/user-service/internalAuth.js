import crypto from "crypto";

// Service-to-service guard for endpoints no end user ever calls.
//
// POST /sync-user runs during registration, before the new user has a token, so
// it cannot use the JWT `protect` middleware. It is reachable through the
// gateway, so without a guard it would accept an attacker-controlled profile --
// including _id, email and a pre-hashed password.
//
// This lives in its own module so the guard is testable directly, against the
// code the service actually runs, rather than through a replica application
// assembled inside a test file.
export const requireInternalAuth = (req, res, next) => {
  const presented = req.headers["x-internal-token"];
  const expected = process.env.INTERNAL_SERVICE_TOKEN;

  // Startup already refuses this state. Reject rather than throw if it occurs
  // anyway, so the failure mode stays 401 and never 500-with-a-stack-trace.
  if (typeof expected !== "string" || expected.length === 0) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // A duplicated header arrives as a comma-joined string and a missing one as
  // undefined; neither is a valid token.
  if (typeof presented !== "string") {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Compare BYTE lengths, not string lengths. `timingSafeEqual` throws a
  // RangeError on a byte-length mismatch, and a multibyte header can match on
  // characters while differing in bytes ("abéd".length === "abcd".length, but
  // the buffers are 5 and 4 bytes). Comparing string lengths therefore let an
  // unauthenticated caller turn this guard into a 500. The byte length of a
  // secret is not itself a useful disclosure.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Constant time, so response latency does not reveal how much of the token
  // matched.
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  next();
};
