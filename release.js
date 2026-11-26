
const { execFileSync } = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function release() {
  try {
    console.log("\n==================================");
    console.log("       TWC RELEASE MANAGER");
    console.log("==================================");
    console.log("1. TWC Spotify Scheduler");
    console.log("2. TWC Spotify Client");

    const choice = await ask("\nSelect application to release (1/2): ");

    let appName;
    let versionPrefix;
    let commitMessage;

    if (choice.trim() === "1") {
      appName = "TWC Spotify Scheduler";
      versionPrefix = "v";
    } else if (choice.trim() === "2") {
      appName = "TWC Spotify Client";
      versionPrefix = "client-v";
    } else {
      throw new Error("Invalid application selection.");
    }

    const version = await ask(`Enter ${appName} version (example: 1.0.1): `);

    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())) {
      throw new Error("Invalid version format.");
    }

    const tag = `${versionPrefix}${version.trim()}`;
    commitMessage =
      choice.trim() === "1"
        ? `Release ${tag}`
        : `Release TWC Spotify Client ${version.trim()}`;

    console.log("\nRelease details:");
    console.log(`Application: ${appName}`);
    console.log(`Version: ${version}`);
    console.log(`Git tag: ${tag}`);

    const confirm = await ask("\nContinue with release? (yes/no): ");

    if (confirm.trim().toLowerCase() !== "yes") {
      console.log("\nRelease cancelled.");
      return;
    }

    // Check for existing remote/local tag
    try {
      execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
        stdio: "ignore",
      });
      throw new Error(`Tag ${tag} already exists locally.`);
    } catch (error) {
      if (error.message.includes("already exists")) throw error;
    }

    try {
      execFileSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
        stdio: "ignore",
      });
      throw new Error(`Tag ${tag} already exists on GitHub.`);
    } catch (error) {
      if (error.message.includes("already exists")) throw error;
    }

    run("git", ["add", "."]);
    run("git", ["commit", "-m", commitMessage]);
    run("git", ["push", "origin", "main"]);
    run("git", ["tag", tag]);
    run("git", ["push", "origin", tag]);

    console.log("\n==================================");
    console.log("       RELEASE PUSHED!");
    console.log("==================================");
    console.log(`${appName} ${version} was pushed to GitHub.`);
    console.log(`Release tag: ${tag}`);
    console.log("GitHub Actions should now process the release.");

  } catch (error) {
    console.error("\nRelease failed:", error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

release();