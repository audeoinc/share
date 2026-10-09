"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildPersistentUdfSql } = require("./lib/deployment_udf_sql");

const javascriptDir = path.resolve(__dirname, "..");
const packageDir = path.resolve(javascriptDir, "..");
const workspaceDir = path.resolve(packageDir, "..");
const version = fs.readFileSync(path.join(javascriptDir, "VERSION"), "utf8").trim();
const releaseName = `lineage_v${version}`;
const releaseDir = path.join(workspaceDir, "release", releaseName);
const zipPath = path.join(workspaceDir, "release", `${releaseName}.zip`);
const deploy = process.argv.includes("--deploy");
const skipTests = process.argv.includes("--skip-tests");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || javascriptDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `${command} failed`;
    throw new Error(detail.trim());
  }
  return result.stdout || "";
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function copyPackage() {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  fs.cpSync(packageDir, releaseDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(packageDir, source);
      return !relative.startsWith("release") && !relative.includes("node_modules");
    }
  });
}

function countGoldenCases() {
  const fixtureDir = path.join(javascriptDir, "test", "golden", "fixtures");
  return fs.readdirSync(fixtureDir).filter((name) => name.endsWith(".sql")).length;
}

function loadConfig() {
  const configPath = path.join(javascriptDir, "release_config.json");
  if (!fs.existsSync(configPath)) {
    if (deploy) {
      throw new Error("--deploy requires javascript/release_config.json");
    }
    return null;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function replaceVersion(value) {
  return value.replaceAll("{version}", version);
}

function writeDeploymentSql(config) {
  if (!config) return null;
  const bundleUri = replaceVersion(config.gcs_bundle_uri);
  // The signature lives in scripts/lib/deployment_udf_sql.js so this path cannot
  // drift from 01_setup_lineage_environment.sql and the redeploy helper.
  const sql = buildPersistentUdfSql({
    project: config.bigquery_project,
    dataset: config.bigquery_dataset,
    functionName: config.bigquery_function,
    bundleUri
  });
  const outputPath = path.join(releaseDir, "sql", "generated", "deploy_persistent_udf.sql");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${sql}\n`, "utf8");
  return outputPath;
}

function main() {
  const startedAt = new Date();
  console.log(`[1/7] Build bundle: ${version}`);
  run(process.execPath, ["scripts/build_udf.js"]);
  run(process.execPath, ["scripts/verify_bundle.js"]);

  if (!skipTests) {
    console.log("[2/7] Run release regression");
    run("npm", ["run", "test:release"]);
  } else {
    console.log("[2/7] Tests skipped by --skip-tests");
  }

  console.log("[3/7] Stage release directory");
  copyPackage();
  const config = loadConfig();
  const deploymentSql = writeDeploymentSql(config);

  const stagedBundle = path.join(releaseDir, "javascript", "dist", "lineage_udf_bundle.js");
  const manifest = {
    schema_version: 1,
    release_name: releaseName,
    version,
    generated_at: new Date().toISOString(),
    source_of_truth: "javascript/src",
    bundle: {
      path: "javascript/dist/lineage_udf_bundle.js",
      sha256: sha256(stagedBundle),
      size_bytes: fs.statSync(stagedBundle).size
    },
    tests: {
      executed: !skipTests,
      status: skipTests ? "SKIPPED" : "PASSED",
      golden_case_count: countGoldenCases()
    },
    artifacts: {
      zip: `${releaseName}.zip`,
      top_level_folder: releaseName,
      deployment_sql: deploymentSql ? path.relative(releaseDir, deploymentSql).replaceAll(path.sep, "/") : null
    },
    deployment: {
      requested: deploy,
      gcs_bundle_uri: config ? replaceVersion(config.gcs_bundle_uri) : null,
      gcs_zip_uri: config ? replaceVersion(config.gcs_zip_uri) : null,
      status: deploy ? "PENDING" : "NOT_REQUESTED"
    },
    duration_ms: Date.now() - startedAt.getTime()
  };
  // Written after the deploy step below, so deployment.status is the real
  // outcome; writeManifest() puts the same bytes in the source tree and the
  // staged release, so the two copies cannot disagree.
  function writeManifest() {
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(releaseDir, "release_manifest.json"), body, "utf8");
    fs.writeFileSync(path.join(packageDir, "release_manifest.json"), body, "utf8");
  }

  // The bundle and the function go out before the manifest is written, so the
  // recorded deployment.status is the outcome rather than an intention, and the
  // ZIP is built last and therefore carries that same manifest.
  if (deploy) {
    console.log("[4/7] Upload bundle to GCS and deploy persistent BigQuery UDF");
    run("gsutil", ["cp", stagedBundle, replaceVersion(config.gcs_bundle_uri)]);
    run("bq", ["query", "--use_legacy_sql=false", fs.readFileSync(deploymentSql, "utf8")]);
    manifest.deployment.status = "DEPLOYED";
  } else {
    console.log("[4/7] GCS upload and BigQuery deploy skipped (use --deploy)");
  }

  console.log("[5/7] Write release manifest");
  writeManifest();

  console.log("[6/7] Create release ZIP");
  fs.rmSync(zipPath, { force: true });
  run("zip", ["-qr", zipPath, releaseName], { cwd: path.dirname(releaseDir) });
  if (deploy) {
    run("gsutil", ["cp", zipPath, replaceVersion(config.gcs_zip_uri)]);
  }

  console.log("[7/7] Build Everything completed");
  console.log(`Release directory: ${releaseDir}`);
  console.log(`Release ZIP:       ${zipPath}`);
}

try {
  main();
} catch (error) {
  console.error(`Build Everything failed: ${error.message}`);
  process.exit(1);
}
