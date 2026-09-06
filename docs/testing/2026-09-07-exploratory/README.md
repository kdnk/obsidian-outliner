# 探索的テスト — 2026-09-07

ノート間操作で、カーソルをリスト記号から退避する処理が別ペインの処理に取り消される不具合を確認した。
実画面での症状、実コードによる再現、正常だった操作、未確認範囲を記録する。
この探索時点では製品コードを修正していなかった。

## 修正の検証

`codex/fix-cross-note-cursor-repair`で、補正タイマーを共通の一個からEditorViewごとの管理へ変更した。
同じペインの新しい予約だけが前の予約を置き換え、別ペインの補正は取り消さない。
resetとプラグイン終了時には全ペインの予約を取り消す。
`MyEditor`は取得するたびに生成されるため、予約のキーにはそのラッパーではなく内部のEditorViewを使う。

[修正後の診断結果](cross-note-cursor-fixed-result.json)では、下記の再現スクリプトは終了コード0、失敗条件なしとなった。
元の[失敗結果](cross-note-cursor-result.json)は調査時の証拠として残している。
スクリプトの代替エディタには、製品の既存APIと同じ`getCodeMirrorView()`を追加した。

[回帰テスト](../../../src/features/__tests__/EditorSelectionCoordination.test.ts)では、二つのペインの同時補正、同じペインでの予約の置換、古いコールバックの無効化、移動元Undo後と両側からのRedo後の文字入力、reset・終了時の予約取り消しを確認した。
Node.js 22.23.1でlint、テストビルド、全81スイートが成功した（898 passed、15 skipped）。
テスト用のObsidianプロセス終了後に元のノート・設定・プラグイン八ファイルを復元し、バックアップとのハッシュ一致を確認した。
AGENTS.mdには、エディタごとの非同期処理で安定したEditorViewをキーに使い、終了時に全予約を取り消す手順を追記した。
実UIで一度観測した症状の修正後の再確認は、Macがロック中のため未実施。

## 確認した不具合：ノート間操作後のカーソル補正

修正優先度は中。
既定の「Keep out of bullets and checkboxes」が有効でも、ノート間Undo/Redo後にカーソルが `- Beta` の `ch: 0` に残る場合がある。
この状態で `X` を入力すると、本文が `- X- Beta` になった。
本文先頭の `ch: 2` に退避できていれば、結果は `- XBeta` になる。

実UIで観測した操作は次のとおり。

1. [source.md](fixtures/source.md) と [destination.md](fixtures/destination.md) を左右に開く。
2. Alphaと子孫の四項目を、移動先のDestination parent配下へ実際のドラッグで移す。
3. 移動先で `Cmd+Z`、続けて `Cmd+Shift+Z` を押す。
4. 移動元のBeta本文をクリックし、移動元で `Cmd+Z` を押す。
5. 両ノートの本文は元へ戻るが、移動元のカーソルが `{line: 11, ch: 0}` になる。
6. クリックや移動キーを挟まず `X` を入力すると、`- X- Beta` になる。

この実UI症状は一度観測した。
その後の直接Undoと同じUndo/Redo経路の試行は、どちらも正常な `ch: 2` へ戻った。
したがって、上記の操作だけで毎回発生するとは確認できておらず、最初の試行に至る編集・選択履歴の影響が残る。
[画面の証拠](cross-note-cursor-ui.png) と [各段階の本文・カーソル](cross-note-cursor-ui.json) を保存した。

実コードを使った [再現用スクリプト](cross-note-cursor.cjs) では、二つのペインが同じターンに選択を変更する場合と、連動したRedoの場合に問題を再現した。
実際のCodeMirrorの履歴、`CrossNoteMove`、選択補正、Parser、カーソル操作を使い、エディタのアダプターとタイマーを代替している。
実ObsidianやGUIは起動しない。

```sh
n exec 22.23.1 node docs/testing/2026-09-07-exploratory/cross-note-cursor.cjs
```

調査時点では終了コード1となり、次の二つの条件に失敗する。

```text
source cursor after paired selection is ch0, expected >= 2
source cursor after paired Redo is ch0, expected >= 2
```

単一エディタの対照と、同じ未修正クラスを各エディタへ別々に割り当てた対照は、いずれも `ch: 2` へ補正された。
[実行結果](cross-note-cursor-result.json) には、移動元の補正タイマーが予約され、移動先の処理によって取り消される順序を記録している。
このスクリプトのRedo経路は「移動 → 移動先Undo → 移動元をクリック → 移動元Redo」であり、実UIの一度のUndo症状と同一手順ではない。

原因は、[EditorSelectionsBehaviourOverride](../../../src/features/EditorSelectionsBehaviourOverride.ts) の63–64行目にある補正タイマーと世代番号が、エディタ間で共有されていること。
130行目以降の予約処理は、予約元のエディタを区別せず前の処理を取り消す。
[CrossNoteMove](../../../src/features/CrossNoteMove.ts) の229行目以降では連動先の履歴トランザクションも準備するため、この競合が発生する。
実UI症状とも整合するが、その一回のタイマー動作を実画面内で計測したわけではない。

修正では、補正処理の予約・取り消しをエディタ単位にすることを優先する。
あわせて、移動元の削除による暗黙のカーソル移動も検討する。
既存のノート間履歴テストに選択補正機能を組み合わせた回帰テストが必要で、履歴処理だけのテストではこの問題を捉えられない。

## 実操作で確認した範囲

| 操作                                      | 観測結果                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| 子と孫を持つ枝のShift+Tab                 | 階層を保ってアウトデントし、Undo後の本文が完全一致                                          |
| Cmd+Shift+Downによる枝の移動、その後のTab | 子孫を伴って移動・インデントし、二回のUndo後に完全一致                                      |
| 親・子への二段階ズーム                    | 対象の枝だけを表示し、パンくずを更新。Propertiesを非表示                                    |
| ズーム末尾でEnter、その空項目でBackspace  | 子項目を追加・削除し、非表示部分を含む本文が元と一致                                        |
| ズーム内でCmd+Aを三回                     | 本文から枝へ選択を拡張し、三回目もズーム外へ出ない                                          |
| ズーム中のプラグイン再読込                | 全体表示へ戻り、取得したエラーバッファに例外なし                                            |
| 同じノートの別ペインから非表示部分を編集  | ズームを解除し、両ペインに変更とUndoが反映                                                  |
| デスクトップの縦線による開閉              | 孫を隠し、直下の末端項目を残す。再度開ける                                                  |
| 同じノート内でBetaの親子をドラッグ        | Alphaの前へ移動し、意図しないズームなし。Undo後に完全一致                                   |
| 別ノートへAlphaの枝をドラッグ             | 移動先の階層へ揃う。移動先Undo/Redoと移動元Undoで両方の本文を復元。カーソルは上記不具合あり |
| モバイルの右端コントロール                | リスト・見出しのfold/unfoldをtouch入力で確認                                                |
| モバイルの長い本文の三行目右端をタップ    | 折りたたまず、本文も変化しない                                                              |
| モバイルの折り返し行の縦線帯をタップ      | 孫を隠し、直下の末端項目を残す                                                              |
| モバイルの長い見出しの開閉                | 見出しの位置を維持し、内部の子のfold状態も維持                                              |
| モバイルの文末近くで開閉                  | 400px・160px位置で往復とも操作行とscrollTopの差が0px。100px位置はfoldまで差が0px            |

モバイルは `app.emulateMobile(true)`、390×844 CSS px、DPR 3、タッチエミュレーションで検証した。
クリック時の `pointerType` が `touch` であることも計測した。
コントロールはx=366–381の15px幅、SVGはx=371–381の10px幅だった。
スクロール領域の `clientWidth` と `scrollWidth` は両方390pxで、横スクロールは増えなかった。
文末の位置指定はレイアウトの丸めにより実測99.875px・159.875px・399.875pxとなり、各操作前にヒット先がコントロール内であることを確認した。
[位置の計測結果](mobile-fold-positions.json) を保存した。

## 環境と検証の限界

- Bullet 5.16.0、Obsidian 1.14.0、Node.js 22.23.1。
- テスト対象はリポジトリ内のvaultのみ。`useTab: true`、`tabSize: 4`。
- origin/mainの基点は `0828076`。ワークスペースには既存の `codex/remove-css-has`、コミット `bb96fae` を含む。
- 今回のテストビルドは成功。前回2026-09-06の全テストは80 suites、891 passed、15 skippedで、今回は製品ソースを変更せず全テストは再実行していない。
- 探索後に取得したエラーバッファとerrorレベルのコンソールにはエラーなし。
- 100px位置のunfold直前にMacが再ロックされ、Computer Useが自動解除に失敗した。その操作は未確認。
- 実際のiOS/Android端末、IME変換、Vim、設定の全組み合わせ、すべてのMarkdown境界を網羅したものではない。

片付けでは、デスクトップモード、タッチエミュレーション無効、元のワークスペースレイアウト、`test.md`の一ペインへ戻した。
元のtest.md、アプリ設定、community-plugins設定、プラグインのbundle・manifest・CSS・dataはバックアップとのハッシュ一致を確認した。
workspace.jsonはアプリによる再保存でバイト単位では一致していない。
作成した三つのテストノートはこのディレクトリのfixturesへ移した。
再ロック後の画面による最終確認と、ロック中の自動解除の修復は未完了。

## 検証手順への追記

Computer Useの`selectText()`がLive Preview上の見えないMarkdownを含む位置とずれ、指定した行と実際のカーソル行が異なるケースがあった。
製品の編集処理を調べる前にこのずれを排除するため、AGENTS.mdへ次を追加した。

> After using Computer Use `selectText()` to set up a Live Preview test, verify the intended CodeMirror line and character range via the vault-guarded Obsidian CLI before editing. AX text offsets may omit hidden Markdown; if they differ, position from a fresh screenshot and verify again.

CLAUDE.mdには同じ手順への参照を追加した。

> For Computer Use tests in Live Preview, follow the caret-position verification procedure in `AGENTS.md` before entering test input.
