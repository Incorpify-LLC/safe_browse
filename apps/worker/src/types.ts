export type ParentContext = { id: string; householdId: string; email: string };
export type DeviceContext = { id: string; childId: string; householdId: string };

export type AppBindings = Env;
export type AppVariables = {
  parent: ParentContext;
  device: DeviceContext;
};

/**
 * True only on a local dev server. This is the ONE place `ENVIRONMENT` is widened
 * from its generated literal type, and it gates two security-relevant branches:
 * the parent auth bypass in auth.ts and the CSRF same-origin skip in parent.ts.
 *
 * `wrangler types` derives `ENVIRONMENT` from wrangler.jsonc, where the committed
 * value is "production" — so TypeScript narrows it to the literal `"production"`
 * and rejects a direct `=== "development"` comparison as unsatisfiable. The cast
 * is required because the value really can differ at runtime: tests and
 * `wrangler dev` override it via `vars`, and the type system cannot see that.
 *
 * Do NOT "fix" the underlying errors by widening `ENVIRONMENT` to `string` in the
 * Env declaration. That would silently re-arm both bypasses everywhere, including
 * production. Keep the widening here, where it is reviewable in one place.
 */
export function isDevelopment(env: AppBindings): boolean {
  return (env.ENVIRONMENT as string) === "development";
}
