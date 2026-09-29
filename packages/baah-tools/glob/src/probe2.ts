import ignore from "ignore";

export const lines: string[] = [];

const ig = ignore().add([".git/", "node_modules/", "dist/", "*.png"]);

const cases = ["node_modules", "node_modules/", "a/node_modules", "a/node_modules/", "dist", "dist/", ".git", ".git/"];
for (const c of cases) {
  try {
    lines.push(`${JSON.stringify(c)} -> ${String(ig.ignores(c))}`);
  } catch (e) {
    lines.push(`${JSON.stringify(c)} -> THREW ${(e as Error).message}`);
  }
}

const gi = ignore().add("logs/\n*.log\n!keep.log\n");
for (const c of ["logs", "logs/", "logs/a.txt", "debug.log", "keep.log", "sub/keep.log"]) {
  lines.push(`gi ${JSON.stringify(c)} -> ${String(gi.ignores(c))}`);
}

const only = ignore().add("node_modules");
for (const c of ["node_modules", "node_modules/x", "src/node_modules/x"]) {
  lines.push(`plain ${JSON.stringify(c)} -> ${String(only.ignores(c))}`);
}
