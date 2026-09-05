import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import typescript from "@rollup/plugin-typescript";
export default (commandLineArgs) => {
  const isWatch = Boolean(commandLineArgs.watch);

  return {
    input: commandLineArgs.configWithTests
      ? "src/ObsidianBulletPluginWithTests.ts"
      : "src/ObsidianBulletPlugin.ts",
    output: {
      file: "dist/main.js",
      sourcemap: isWatch ? "inline" : false,
      format: "cjs",
      exports: "default",
    },
    external: [
      "obsidian",
      "codemirror",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
    ],
    plugins: [
      replace({ preventAssignment: true }),
      typescript(),
      nodeResolve({ browser: true }),
      commonjs(),
    ],
  };
};
