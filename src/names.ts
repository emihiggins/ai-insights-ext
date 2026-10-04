/**
 * Human-readable labels for model ids and project directories. Pure logic with
 * no Node or vscode imports, so the webview bundle can use it too.
 */

const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * `claude-opus-5-5` → "Opus 5.5", `claude-3-5-haiku-20241022` → "Haiku 3.5",
 * `us.anthropic.claude-sonnet-4-6` → "Sonnet 4.6". Unknown ids pass through.
 */
export function modelLabel(modelId: string | undefined): string {
  if (!modelId) {
    return "—";
  }
  const idx = modelId.indexOf("claude-");
  const bare = (idx >= 0 ? modelId.slice(idx) : modelId).split("@")[0];
  const parts = bare.split("-").slice(1); // drop "claude"
  // Version parts are 1–2 digit numbers; 8-digit date suffixes are dropped.
  const isVersion = (p: string): boolean => /^\d{1,2}$/.test(p);
  const family = parts.find((p) => FAMILIES.includes(p));
  if (!family) {
    return modelId;
  }
  const famIdx = parts.indexOf(family);
  const after = parts.slice(famIdx + 1).filter(isVersion);
  const before = parts.slice(0, famIdx).filter(isVersion);
  const version = (after.length ? after : before).join(".");
  return version ? `${cap(family)} ${version}` : cap(family);
}

/** Last path segment of a POSIX or Windows path. */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const segs = trimmed.split(/[\\/]/);
  return segs[segs.length - 1] || trimmed;
}

function parentAndBase(p: string): string {
  const segs = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return segs.slice(-2).join("/");
}

/**
 * Display labels for encoded project directories (`-Users-me-code-app`),
 * using the most common working directory seen in each project's sessions.
 * Labels that collide get their parent directory prepended.
 */
export function projectLabels(cwdsByProject: Map<string, string[]>): Map<string, string> {
  const primaryCwd = new Map<string, string | undefined>();
  for (const [project, cwds] of cwdsByProject) {
    const counts = new Map<string, number>();
    for (const c of cwds) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [c, n] of counts) {
      if (n > bestCount) {
        best = c;
        bestCount = n;
      }
    }
    primaryCwd.set(project, best);
  }

  const base = new Map<string, string>();
  for (const [project, cwd] of primaryCwd) {
    base.set(project, cwd ? basename(cwd) : project.replace(/^-+/, ""));
  }
  const uses = new Map<string, number>();
  for (const label of base.values()) {
    uses.set(label, (uses.get(label) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [project, label] of base) {
    const cwd = primaryCwd.get(project);
    out.set(project, (uses.get(label) ?? 0) > 1 && cwd ? parentAndBase(cwd) : label);
  }
  return out;
}
