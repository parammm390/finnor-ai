set -u
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:/usr/bin:/bin
export PLAYWRIGHT_BROWSERS_PATH=/home/factory-user/repos/fzv-browsers
cd /home/factory-user/repos/fzv-w-z1 || exit 1
ls /home/factory-user/repos/fzv-browsers
echo "--- node_modules present:"; ls node_modules | wc -l; ls finnor-os/node_modules | wc -l
node -e '
const { createRequire } = require("node:module");
const r = createRequire("/home/factory-user/repos/fzv-w-z1/package.json");
const { chromium } = r("@playwright/test");
console.log("executablePath", chromium.executablePath());
(async () => {
  for (const sandbox of [true, false]) {
    try {
      const b = await chromium.launch({ headless: true, chromiumSandbox: sandbox });
      const p = await (await b.newContext()).newPage();
      await p.goto("data:text/html,<title>x</title>");
      console.log("sandbox", sandbox, "OK", await p.title(), b.version());
      await b.close();
    } catch (e) { console.log("sandbox", sandbox, "FAILED", String(e.message).split("\n")[0].slice(0, 200)); }
  }
})();
'
echo "unprivileged userns:"; cat /proc/sys/kernel/unprivileged_userns_clone 2>&1; cat /proc/sys/user/max_user_namespaces 2>&1
