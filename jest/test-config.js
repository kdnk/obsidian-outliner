const manifest = require("../manifest.json");

const TEST_VAULT_APP_CONFIG = Object.freeze({
  foldHeading: true,
  foldIndent: true,
  useTab: true,
  tabSize: 4,
  legacyEditor: false,
  propertiesInDocument: "visible",
});

function getTestPluginId() {
  return manifest.id;
}

function getVaultPluginDir(vaultDir) {
  return `${vaultDir}/.obsidian/plugins/${getTestPluginId()}`;
}

module.exports = {
  getTestPluginId,
  getVaultPluginDir,
  TEST_VAULT_APP_CONFIG,
};
