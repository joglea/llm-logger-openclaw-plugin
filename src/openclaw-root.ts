import fs from "node:fs";
import path from "node:path";

function isOpenClawRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    return parsed.name === "openclaw";
  } catch {
    return false;
  }
}

function walkUp(startPath: string): string | null {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isFile() ? path.dirname(startPath) : startPath;

  while (true) {
    if (isOpenClawRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveOpenClawRoot(params: {
  workspaceDir?: string;
} = {}): string {
  const candidates = [
    process.argv[1],
    params.workspaceDir,
    process.cwd(),
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

  for (const candidate of candidates) {
    const resolved = walkUp(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("unable to resolve openclaw package root from process context");
}
