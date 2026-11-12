import { writeFileSync } from "node:fs";
import path from "node:path";

const [role, ...args] = process.argv.slice(2);
if (role !== "codex" && role !== "node") process.exit(91);
writeFileSync(
  path.join(process.env.CAPABILITY_TEST_CAPTURE, `${role}.json`),
  JSON.stringify({ cwd: process.cwd(), args }),
);
process.exit(role === "codex" ? Number(process.env.CAPABILITY_TEST_EXIT) : 0);
