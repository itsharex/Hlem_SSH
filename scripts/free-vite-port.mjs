import { execFileSync } from "node:child_process";
import { cwd, platform } from "node:process";

const port = "1420";

if (platform !== "win32") {
  process.exit(0);
}

const workspace = cwd().replace(/'/g, "''");
const script = `
$workspace = (Resolve-Path -LiteralPath '${workspace}').Path
$connections = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue
foreach ($connection in $connections) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
  if ($owner -and $owner.CommandLine -like "*$workspace*") {
    Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
`;

try {
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
  });
} catch {
  process.exit(0);
}
