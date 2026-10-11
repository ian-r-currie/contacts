// Runs the API server and the Vite dev server together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() };
const procs = [
  spawn("npx", ["tsx", "watch", "server/index.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite"], { stdio: "inherit", env }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { stop(); process.exitCode = code ?? 0; }));
