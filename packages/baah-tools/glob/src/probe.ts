import picomatch from "picomatch";

const isTs = picomatch("**/*.ts", { dot: false });
console.log("**/*.ts a.ts", isTs("a.ts"));
console.log("**/*.ts src/a.ts", isTs("src/a.ts"));
console.log("**/*.ts src/deep/a.ts", isTs("src/deep/a.ts"));
console.log("**/*.ts .hidden/a.ts", isTs(".hidden/a.ts"));

const star = picomatch("*.ts", { dot: false });
console.log("*.ts a.ts", star("a.ts"));
console.log("*.ts src/a.ts", star("src/a.ts"));

const star2 = picomatch("src/*", { dot: false });
console.log("src/* src/a.ts", star2("src/a.ts"));
console.log("src/* src/deep/a.ts", star2("src/deep/a.ts"));

const star3 = picomatch("src/**", { dot: false });
console.log("src/** src/deep/a.ts", star3("src/deep/a.ts"));

const ext = picomatch("*.{ts,tsx}", { dot: false });
console.log("*.{ts,tsx} a.tsx", ext("a.tsx"));

console.log("literal a+b", picomatch("a+b", { dot: false })("a+b"));
console.log("regex-ish a+b on axb", picomatch("a+b", { dot: false })("axb"));
