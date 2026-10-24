// Run the on-device version in dev (port 3001) next to the laptop/server version on port 3000.
import { spawn } from "node:child_process";

const env = { ...process.env, NEXT_PUBLIC_ENGINE: "local", NEXT_DIST_DIR: ".next-local" };
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3001"], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
