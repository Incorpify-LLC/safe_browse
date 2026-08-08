import { categories, presetCategories, type AgeBand, type Category, type Policy } from "@safe-browse/contracts";

type ChildRow = {
  id: string;
  ageBand: AgeBand;
  timezone: string;
  policyVersion: number;
  safeSearch: number;
  youtubeRestricted: number;
  paused: number;
};

export async function createDefaultCategories(db: D1Database, childId: string, ageBand: AgeBand): Promise<void> {
  const enabled = new Set(presetCategories[ageBand]);
  await db.batch(categories.map((category) => db.prepare(
    "INSERT INTO policy_categories(child_id,category,enabled) VALUES(?,?,?)",
  ).bind(childId, category, enabled.has(category) ? 1 : 0)));
}

export async function buildPolicy(db: D1Database, childId: string, listVersion: string): Promise<Policy | null> {
  const child = await db.prepare(
    `SELECT id, age_band AS ageBand, timezone, policy_version AS policyVersion,
            safe_search AS safeSearch, youtube_restricted AS youtubeRestricted, paused
     FROM children WHERE id = ?`,
  ).bind(childId).first<ChildRow>();
  if (!child) return null;

  const [categoryRows, scheduleRows, ruleRows] = await Promise.all([
    db.prepare("SELECT category FROM policy_categories WHERE child_id = ? AND enabled = 1 ORDER BY category")
      .bind(childId).all<{ category: Category }>(),
    db.prepare(
      `SELECT category, days_json AS daysJson, start_minutes AS startMinutes, end_minutes AS endMinutes
       FROM schedules WHERE child_id = ? ORDER BY category, start_minutes`,
    ).bind(childId).all<{ category: Category; daysJson: string; startMinutes: number; endMinutes: number }>(),
    db.prepare(
      `SELECT domain, action, expires_at AS expiresAt FROM domain_rules
       WHERE child_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY domain`,
    ).bind(childId, new Date().toISOString()).all<{ domain: string; action: "allow" | "block"; expiresAt: string | null }>(),
  ]);

  return {
    version: child.policyVersion,
    childId: child.id,
    ageBand: child.ageBand,
    timezone: child.timezone,
    enabledCategories: categoryRows.results.map((row) => row.category),
    schedules: scheduleRows.results.map((row) => ({
      category: row.category,
      days: JSON.parse(row.daysJson) as number[],
      startMinutes: row.startMinutes,
      endMinutes: row.endMinutes,
    })),
    domainRules: ruleRows.results,
    safeSearch: child.safeSearch === 1,
    youtubeRestricted: child.youtubeRestricted === 1,
    paused: child.paused === 1,
    listVersion,
    generatedAt: new Date().toISOString(),
  };
}

export async function latestListVersion(bucket?: R2Bucket): Promise<string> {
  if (!bucket) return "bootstrap";
  const object = await bucket.get("lists/latest.json");
  if (!object) return "bootstrap";
  const metadata = await object.json<{ version?: string }>();
  return typeof metadata.version === "string" ? metadata.version : "bootstrap";
}

export async function incrementPolicy(db: D1Database, childId: string): Promise<void> {
  await db.prepare("UPDATE children SET policy_version = policy_version + 1 WHERE id = ?").bind(childId).run();
}
