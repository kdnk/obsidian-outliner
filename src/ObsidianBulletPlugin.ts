import { Plugin } from "obsidian";

import { ArrowLeftAndCtrlArrowLeftBehaviourOverride } from "./features/ArrowLeftAndCtrlArrowLeftBehaviourOverride";
import { BackspaceBehaviourOverride } from "./features/BackspaceBehaviourOverride";
import { BetterListsStyles } from "./features/BetterListsStyles";
import { BulletTypingGuard } from "./features/BulletTypingGuard";
import { CtrlAAndCmdABehaviourOverride } from "./features/CtrlAAndCmdABehaviourOverride";
import { DeleteBehaviourOverride } from "./features/DeleteBehaviourOverride";
import { DragAndDrop } from "./features/DragAndDrop";
import { EditorSelectionsBehaviourOverride } from "./features/EditorSelectionsBehaviourOverride";
import { EnterBehaviourOverride } from "./features/EnterBehaviourOverride";
import { Feature } from "./features/Feature";
import { ListZoom } from "./features/ListZoom";
import { ListsFoldingCommands } from "./features/ListsFoldingCommands";
import { ListsMovementCommands } from "./features/ListsMovementCommands";
import { MetaBackspaceBehaviourOverride } from "./features/MetaBackspaceBehaviourOverride";
import { MobileRightFoldControls } from "./features/MobileRightFoldControls";
import { NativeFoldScroll } from "./features/NativeFoldScroll";
import { SettingsTab } from "./features/SettingsTab";
import { ShiftTabBehaviourOverride } from "./features/ShiftTabBehaviourOverride";
import { SystemInfo } from "./features/SystemInfo";
import { TabBehaviourOverride } from "./features/TabBehaviourOverride";
import { VerticalLines } from "./features/VerticalLines";
import { VimOBehaviourOverride } from "./features/VimOBehaviourOverride";
import { ChangesApplicator } from "./services/ChangesApplicator";
import { IMEDetector } from "./services/IMEDetector";
import { Logger } from "./services/Logger";
import { ObsidianSettings } from "./services/ObsidianSettings";
import { OperationPerformer } from "./services/OperationPerformer";
import { Parser } from "./services/Parser";
import { Settings } from "./services/Settings";

export default class ObsidianBulletPlugin extends Plugin {
  protected features!: Feature[];
  settings!: Settings;
  private logger!: Logger;
  private obsidianSettings!: ObsidianSettings;
  protected parser!: Parser;
  private changesApplicator!: ChangesApplicator;
  protected operationPerformer!: OperationPerformer;
  private imeDetector!: IMEDetector;

  async onload() {
    await this.prepareSettings();

    this.obsidianSettings = new ObsidianSettings(this.app);
    this.logger = new Logger(this.settings);
    this.parser = new Parser(this.logger, this.settings);
    this.changesApplicator = new ChangesApplicator();
    this.operationPerformer = new OperationPerformer(
      this.parser,
      this.changesApplicator,
    );

    this.imeDetector = new IMEDetector();
    await this.imeDetector.load();

    this.features = [
      // service features
      new SettingsTab(this, this.settings),
      new SystemInfo(this, this.settings),

      // general features
      new ListsMovementCommands(
        this,
        this.obsidianSettings,
        this.operationPerformer,
      ),
      new ListsFoldingCommands(this, this.obsidianSettings),
      new ListZoom(this, this.parser),

      // features based on settings.keepBodyTextInBullets
      new BulletTypingGuard(this, this.settings, this.logger),

      // features based on settings.keepCursorWithinContent
      new EditorSelectionsBehaviourOverride(
        this,
        this.settings,
        this.parser,
        this.operationPerformer,
      ),
      new ArrowLeftAndCtrlArrowLeftBehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.operationPerformer,
      ),
      new BackspaceBehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.obsidianSettings,
        this.operationPerformer,
      ),
      new MetaBackspaceBehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.operationPerformer,
      ),
      new DeleteBehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.obsidianSettings,
        this.operationPerformer,
      ),

      // features based on settings.overrideTabBehaviour
      new TabBehaviourOverride(
        this,
        this.imeDetector,
        this.obsidianSettings,
        this.settings,
        this.operationPerformer,
      ),
      new ShiftTabBehaviourOverride(
        this,
        this.imeDetector,
        this.obsidianSettings,
        this.settings,
        this.operationPerformer,
      ),

      // features based on settings.overrideEnterBehaviour
      new EnterBehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.obsidianSettings,
        this.operationPerformer,
      ),

      // features based on settings.overrideVimOBehaviour
      new VimOBehaviourOverride(
        this,
        this.settings,
        this.obsidianSettings,
        this.operationPerformer,
      ),

      // features based on settings.overrideSelectAllBehaviour
      new CtrlAAndCmdABehaviourOverride(
        this,
        this.settings,
        this.imeDetector,
        this.operationPerformer,
      ),

      // features based on settings.betterListsStyles
      new BetterListsStyles(this, this.settings),

      // features based on settings.mobileRightFoldControls
      new MobileRightFoldControls(this, this.settings),
      new NativeFoldScroll(this),

      // vertical-line folding and outer list guides
      new VerticalLines(this, this.settings, this.parser),

      // features based on settings.dragAndDrop
      new DragAndDrop(
        this,
        this.settings,
        this.obsidianSettings,
        this.parser,
        this.operationPerformer,
      ),
    ];

    for (const feature of this.features) {
      await feature.load();
    }
  }

  onunload() {
    void this.unloadFeatures();
  }

  private async unloadFeatures() {
    await this.imeDetector.unload();

    for (const feature of this.features) {
      await feature.unload();
    }
  }

  protected async prepareSettings() {
    this.settings = new Settings(this);
    await this.settings.load();
  }
}
