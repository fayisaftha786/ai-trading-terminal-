import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim().length > 0);

if (scripts.length === 0) {
  throw new Error("No inline dashboard JavaScript was found to validate.");
}

for (let index = 0; index < scripts.length; index += 1) {
  const result = spawnSync(process.execPath, ["--check", "-"], {
    input: scripts[index],
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Dashboard JavaScript syntax check failed.\\n");
    process.exit(result.status || 1);
  }
}

process.stdout.write("Dashboard inline JavaScript syntax: PASS (" + scripts.length + " script block(s))\\n");
