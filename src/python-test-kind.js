import fs from "node:fs";
import path from "node:path";

export function usesUnittest(root) {
  try {
    return fs.readdirSync(path.join(root, "tests"))
      .filter((name) => /^test.*\.py$/u.test(name))
      .slice(0, 500)
      .some((name) => {
        const file = path.join(root, "tests", name);
        const stat = fs.lstatSync(file);
        return stat.isFile()
          && stat.size <= 1_000_000
          && /\bunittest\b/u.test(fs.readFileSync(file, "utf8"));
      });
  } catch {
    return false;
  }
}
